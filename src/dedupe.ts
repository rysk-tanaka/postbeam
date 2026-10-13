const CLAIM_PREFIX = "claimed:";
// Misskey の再送が終わるまでの期間を十分に上回る長さにする
const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
// KV は同じキーへの書き込み（削除を含む）を 1 秒に 1 回までに制限している
const SAME_KEY_WRITE_INTERVAL_MS = 1100;
const RELEASE_RETRIES = 2;
// 遅れて届いた書き込みに作り直された記録を消し直すときの再試行。waitUntil の猶予に収まる回数にする
const REDELETE_RETRIES = 1;
// KV が遅いと Misskey の 5 秒の切断までの時間を使い切るため、読み書きを打ち切って記録なしで進める
const KV_TIMEOUT_MS = 1000;
// 削除は応答の後に行うので長めに待つ。ただし返らないまま waitUntil の猶予を使い切ると、
// 失敗のログも出ずに打ち切られるため、再試行を含めて猶予に収まる長さで打ち切る
const DELETE_TIMEOUT_MS = 2000;
// 打ち切った書き込みの完了を待つ上限。削除の前と、書き込みの後の削除で確かめ直す必要がある
// とき（needsDeleteAfterWrite）の 2 回待つ。書き込みが終わらないのは claim-failed（投稿先の
// 上限が 4 秒）のときだけで、2 回の待ちと消し直しを含めても応答から最長で約 25.5 秒になり、
// waitUntil の 30 秒の猶予の中で失敗をログに残せる
const PENDING_WRITE_WAIT_MS = 5000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// KV が拒んだことが確かで、反映されていない失敗のメッセージ。同じキーへの書き込み制限
// （`KV DELETE failed: 429 Too Many Requests`）と、無料プランの 1 日の上限
// （`KV delete() limit exceeded for the day.`）。429 は、ほかの文字列に紛れた数字を拒否と
// 取り違えないよう、KV の失敗の形に限る。形が違えば、反映されたかもしれない失敗に倒れる
const KV_REJECTED_PATTERNS = [
  /\bKV \w+ failed: 429\b/i,
  /limit exceeded for the day/i,
];

/** KV が拒んだことが確かな失敗か。それ以外の失敗は、反映されたまま例外になっていることがある */
function isRejectedByKv(err: unknown): boolean {
  return (
    err instanceof Error &&
    KV_REJECTED_PATTERNS.some((pattern) => pattern.test(err.message))
  );
}

/** KV の操作に上限をかける。打ち切っても操作自体は続くため、書き込みは保存されることがある */
async function withKvTimeout<T>(
  operation: string,
  promise: Promise<T>,
  timeoutMs = KV_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`kv ${operation} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 記録の書き込みの結果。
 * stored は保存できた、failed は例外で終わった、pending はまだ終わっていない。
 * failed でも、保存されたまま例外になっていることはある
 */
export type ClaimWrite = "stored" | "failed" | "pending";

/**
 * 記録の削除の結果。claimWrite は返す時点の記録の書き込みの結果で、
 * ログで再送の結果（投稿し直されるか、スキップされるか）を見分けるために使う
 */
export type ReleaseResult =
  | { isReleased: true; claimWrite: ClaimWrite }
  | {
      isReleased: false;
      claimWrite: ClaimWrite;
      /**
       * 記録が消えているかもしれない。書き込みは完了の通知より先に KV に保存されていて、
       * 先に消せた削除がそれを消していたかもしれない。打ち切った削除は後で届いて消すことがあり、
       * 例外で終わった削除も、反映されたまま例外になっていることがある
       */
      mayHaveDeleted: boolean;
      error: unknown;
    };

export interface ClaimRecord {
  claimedAt?: string;
}

function parseClaimRecord(value: string): ClaimRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  const claimedAt = (parsed as { claimedAt?: unknown } | null)?.claimedAt;
  return typeof claimedAt === "string" ? { claimedAt } : {};
}

/**
 * deleteWithRetries の結果。needsDeleteAfterWrite は、書き込みの後の削除で確かめ直す必要があるか。
 * 書き込みが終わった後に始めた削除がないか、書き込みが終わる前に始めた削除が記録を消したかも
 * しれず、書き込みの後の削除で消せていないときに当たる。どちらも、遅れて届いた書き込みで
 * 記録が残るか、作り直されていることがある。
 * mayHaveDeleted は、KV が拒んだことが確かな失敗以外の失敗（打ち切りを含む）があるか
 */
type DeleteOutcome =
  | { isReleased: true; needsDeleteAfterWrite: boolean }
  | {
      isReleased: false;
      needsDeleteAfterWrite: boolean;
      mayHaveDeleted: boolean;
      error: unknown;
    };

/**
 * ノートの転送を引き受けたことを KV に記録し、Misskey の再送で二重に投稿しないようにする。
 *
 * 投稿の直前に記録し、投稿に成功しても結果が不明でも残して、TTL で消えるのを待つ。
 * 再送で成功しうる失敗（unavailable）のときだけ記録を消し、再送で投稿し直せるようにする。
 */
export class DeliveryLog {
  /**
   * 同じキーへの書き込み制限に合わせるため、直前の書き込みか削除が終わった（成否によらない）時刻
   */
  private lastKeyOpAt: number | undefined;
  /**
   * 直前の claim の書き込みの完了。打ち切った後も続いていることがあるため、
   * 削除がこれに追い越されないよう、削除の前に待つ
   */
  private pendingWrite: Promise<void> | undefined;
  /** 直前の claim の書き込みの結果。claim の前は、記録があるものとして stored にする */
  private claimWrite: ClaimWrite = "stored";

  constructor(private readonly kv: KVNamespace) {}

  /**
   * 記録を探す。記録がなければ null。
   * 値は調査用なので、壊れていても記録があるものとして扱い、再送で二重に投稿しない。
   */
  async findClaim(noteId: string): Promise<ClaimRecord | null> {
    const value = await withKvTimeout(
      "get",
      this.kv.get(CLAIM_PREFIX + noteId),
    );
    if (value === null) return null;
    return parseClaimRecord(value);
  }

  async claim(noteId: string): Promise<void> {
    // 値は調査用。重複の判定にはキーの有無だけを使う。
    // put が同期的に例外を投げても、書き込みの失敗として pendingWrite に残すため async で包む
    const write = (async () =>
      this.kv.put(
        CLAIM_PREFIX + noteId,
        JSON.stringify({
          claimedAt: new Date().toISOString(),
        } satisfies ClaimRecord),
        { expirationTtl: CLAIM_TTL_SECONDS },
      ))();
    // 書き込み制限の間隔は書き込みが終わってから数える。
    // 例外になっても保存されていることがあるため、成否によらず残す
    const markWritten = (result: ClaimWrite) => () => {
      this.lastKeyOpAt = Date.now();
      this.claimWrite = result;
    };
    this.claimWrite = "pending";
    this.pendingWrite = write.then(
      markWritten("stored"),
      markWritten("failed"),
    );
    await withKvTimeout("put", write);
  }

  /**
   * 記録を消す。直前の claim と同じキーへの書き込みになるため、
   * 書き込みが終わるのを待ってから間を空け、失敗したら間を空けて再試行する。
   * 応答の後に呼ぶ前提で、待っても応答は遅れない。例外は投げず、結果を返す。
   *
   * 書き込みが終わる前に始めた削除は、後で届いた書き込みに記録を作り直されることがある。
   * 書き込みの後の削除で確かめ直す必要があれば（needsDeleteAfterWrite）、書き込みの完了を
   * もう一度待ち、終われば消し直す。それでも終わらなければ、claimWrite は pending のまま返す。
   */
  async release(noteId: string): Promise<ReleaseResult> {
    // claim の前に呼ばれることはないが、そのときは書き込みの完了を待たずに消す
    await this.waitForClaimWrite();
    const first = await this.deleteWithRetries(noteId, RELEASE_RETRIES);
    if (!first.needsDeleteAfterWrite) return this.toResult(first);
    await this.waitForClaimWrite();
    if (this.claimWrite === "pending") return this.toResult(first);
    // failed でも保存されていることがあるため、成否によらず消し直す
    const retry = await this.deleteWithRetries(noteId, REDELETE_RETRIES);
    if (retry.isReleased) return this.toResult(retry);
    // 書き込みが完了の通知より先に KV に保存されていれば、先に消せた削除がそれを消している。
    // 先に打ち切った削除や例外で終わった削除も、記録を消していることがある
    const hasFirstDeleted = first.isReleased || first.mayHaveDeleted;
    return this.toResult({
      ...retry,
      mayHaveDeleted: retry.mayHaveDeleted || hasFirstDeleted,
    });
  }

  /**
   * 記録の書き込みの完了を、PENDING_WRITE_WAIT_MS まで待つ。削除が、まだ終わっていない
   * 書き込みに追い越されないようにするため。待ちきれなくても、結果は claimWrite の pending で伝わる
   */
  private async waitForClaimWrite(): Promise<void> {
    if (!this.pendingWrite) return;
    await withKvTimeout("put", this.pendingWrite, PENDING_WRITE_WAIT_MS).catch(
      () => {},
    );
  }

  /**
   * 記録を消す。失敗したら retries 回まで再試行する。
   * どの削除も、直前の書き込みか削除から書き込み制限の間隔を空けてから行う
   */
  private async deleteWithRetries(
    noteId: string,
    retries: number,
  ): Promise<DeleteOutcome> {
    let lastError: unknown;
    let mayHaveDeleted = false;
    let mayHaveDeletedBeforeWrite = false;
    let hasAttemptAfterWrite = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.waitForKeyInterval();
      // 削除を始める前に決める。削除の途中で書き込みが終わったときも、書き込みの前として扱う
      const isAfterWrite = this.claimWrite !== "pending";
      hasAttemptAfterWrite ||= isAfterWrite;
      try {
        await withKvTimeout(
          "delete",
          this.kv.delete(CLAIM_PREFIX + noteId),
          DELETE_TIMEOUT_MS,
        );
        // 書き込みの後に消せていれば、作り直されることはない
        return { isReleased: true, needsDeleteAfterWrite: !isAfterWrite };
      } catch (err) {
        lastError = err;
        // 書き込みと同じく、例外で終わっても反映されていることがある
        const mayHaveApplied = !isRejectedByKv(err);
        mayHaveDeleted ||= mayHaveApplied;
        mayHaveDeletedBeforeWrite ||= mayHaveApplied && !isAfterWrite;
      } finally {
        this.lastKeyOpAt = Date.now();
      }
    }
    // 書き込みの後に削除を試して失敗しただけなら、記録が作り直される心配はなく、消し直しても
    // 再試行が増えるだけなので確かめ直さない
    return {
      isReleased: false,
      needsDeleteAfterWrite: !hasAttemptAfterWrite || mayHaveDeletedBeforeWrite,
      mayHaveDeleted,
      error: lastError,
    };
  }

  /**
   * 同じキーへの直前の書き込みか削除から、書き込み制限の間隔を空ける。
   * まだどちらも終わっていなければ（書き込みが打ち切られたままか、claim の前）、
   * たった今終わったものとして空ける。待っている間に書き込みが終われば、その書き込みから空け直す。
   * 空け直すのは操作の時刻が新しくなったときだけなので、時計が進まなくても待ち続けない
   * （Workers は I/O が起きるまで Date.now() を進めない）
   */
  private async waitForKeyInterval(): Promise<void> {
    let lastOpAt = this.lastKeyOpAt ?? Date.now();
    for (;;) {
      const waitMs = SAME_KEY_WRITE_INTERVAL_MS - (Date.now() - lastOpAt);
      if (waitMs > 0) await sleep(waitMs);
      const latestOpAt = this.lastKeyOpAt;
      if (latestOpAt === undefined || latestOpAt <= lastOpAt) return;
      lastOpAt = latestOpAt;
    }
  }

  /**
   * 削除の結果に、返す時点の記録の書き込みの結果を添える。削除を始めた時点で pending でも、
   * その後に終わった書き込みの結果で、再送がスキップされるか投稿し直されるかが決まるため
   */
  private toResult(outcome: DeleteOutcome): ReleaseResult {
    if (outcome.isReleased) {
      return { isReleased: true, claimWrite: this.claimWrite };
    }
    return {
      isReleased: false,
      claimWrite: this.claimWrite,
      mayHaveDeleted: outcome.mayHaveDeleted,
      error: outcome.error,
    };
  }
}
