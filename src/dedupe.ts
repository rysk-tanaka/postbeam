const CLAIM_PREFIX = "claimed:";
// Misskey の再送が終わるまでの期間を十分に上回る長さにする
const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
// KV は同じキーへの書き込みを 1 秒に 1 回までに制限している
const SAME_KEY_WRITE_INTERVAL_MS = 1100;
const RELEASE_RETRIES = 2;
// KV が遅いと Misskey の 5 秒の切断までの時間を使い切るため、読み書きを打ち切って記録なしで進める
const KV_TIMEOUT_MS = 1000;
// 削除は応答の後に行うので長めに待つ。ただし返らないまま waitUntil の猶予を使い切ると、
// 失敗のログも出ずに打ち切られるため、再試行を含めて猶予に収まる長さで打ち切る
const DELETE_TIMEOUT_MS = 2000;
// 打ち切った書き込みの完了を、削除の前に待つ上限。waitUntil の 30 秒の猶予の中で、
// 削除と再試行を終えて失敗をログに残せるようにする
const PENDING_WRITE_WAIT_MS = 5000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
 * 削除の前に確かめた、記録の書き込みの結果。
 * stored は保存できた、failed は例外で終わった、pending は待っても終わらなかった。
 * failed でも、保存されたまま例外になっていることはある
 */
export type ClaimWrite = "stored" | "failed" | "pending";

/** 記録を消せなかった。書き込みの結果を、ログで再送の結果を見分けるために運ぶ */
export class ReleaseError extends Error {
  constructor(
    readonly claimWrite: ClaimWrite,
    cause: unknown,
  ) {
    super(`failed to release claim: ${String(cause)}`, { cause });
    this.name = "ReleaseError";
  }
}

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
 * ノートの転送を引き受けたことを KV に記録し、Misskey の再送で二重に投稿しないようにする。
 *
 * 投稿の直前に記録し、投稿に成功しても結果が不明でも残して、TTL で消えるのを待つ。
 * 再送で成功しうる失敗（unavailable）のときだけ記録を消し、再送で投稿し直せるようにする。
 */
export class DeliveryLog {
  /** 同じキーへの書き込み制限に合わせるため、記録の書き込みが終わった（成否によらない）時刻 */
  private lastWriteAt: number | undefined;
  /**
   * 直前の claim の書き込みと、その結果。打ち切った後も続いていることがあるため、
   * 削除がこれに追い越されないよう削除の前に待ち、結果を ClaimWrite として返す
   */
  private pendingWrite: Promise<ClaimWrite> | undefined;

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
      this.lastWriteAt = Date.now();
      return result;
    };
    this.pendingWrite = write.then(
      markWritten("stored"),
      markWritten("failed"),
    );
    await withKvTimeout("put", write);
  }

  /**
   * 記録を消す。直前の claim と同じキーへの書き込みになるため、
   * 書き込みが終わるのを待ってから間を空け、失敗したら間を空けて再試行する。
   * 応答の後に呼ぶ前提で、待っても応答は遅れない。
   *
   * claimWrite は、削除の前に確かめた記録の書き込みの結果。pending なら、
   * 書き込みが削除の後に届いて記録が作り直され、再送がスキップされることがある。
   * 削除がすべて失敗したときは、claimWrite を持つ ReleaseError を投げる。
   */
  async release(noteId: string): Promise<{ claimWrite: ClaimWrite }> {
    // 打ち切った書き込みが削除の後に届くと、記録が作り直されて再送がスキップされる。
    // claim の前に呼ばれることはないが、そのときは記録があるものとして扱う
    const claimWrite: ClaimWrite = this.pendingWrite
      ? await withKvTimeout(
          "put",
          this.pendingWrite,
          PENDING_WRITE_WAIT_MS,
        ).catch(() => "pending" as const)
      : "stored";
    let lastError: unknown;
    for (let attempt = 0; attempt <= RELEASE_RETRIES; attempt++) {
      // 書き込みがまだ終わっていなければ、たった今書いたものとして間を空ける
      const sinceWrite = Date.now() - (this.lastWriteAt ?? Date.now());
      const waitMs =
        attempt === 0
          ? SAME_KEY_WRITE_INTERVAL_MS - sinceWrite
          : SAME_KEY_WRITE_INTERVAL_MS;
      if (waitMs > 0) await sleep(waitMs);
      try {
        await withKvTimeout(
          "delete",
          this.kv.delete(CLAIM_PREFIX + noteId),
          DELETE_TIMEOUT_MS,
        );
        return { claimWrite };
      } catch (err) {
        lastError = err;
      }
    }
    throw new ReleaseError(claimWrite, lastError);
  }
}
