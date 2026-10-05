const CLAIM_PREFIX = "claimed:";
// Misskey の再送が終わるまでの期間を十分に上回る長さにする
const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
// KV は同じキーへの書き込みを 1 秒に 1 回までに制限している
const SAME_KEY_WRITE_INTERVAL_MS = 1100;
const RELEASE_RETRIES = 2;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * ノートの転送を引き受けたことを KV に記録し、Misskey の再送で二重に投稿しないようにする。
 *
 * 投稿の直前に記録し、投稿に成功しても結果が不明でも残して、TTL で消えるのを待つ。
 * 再送で成功しうる失敗（unavailable）のときだけ記録を消し、再送で投稿し直せるようにする。
 */
export class DeliveryLog {
  constructor(private readonly kv: KVNamespace) {}

  async isClaimed(noteId: string): Promise<boolean> {
    return (await this.kv.get(CLAIM_PREFIX + noteId)) !== null;
  }

  async claim(noteId: string): Promise<void> {
    // 値は調査用。重複の判定にはキーの有無だけを使う
    await this.kv.put(
      CLAIM_PREFIX + noteId,
      JSON.stringify({ claimedAt: new Date().toISOString() }),
      { expirationTtl: CLAIM_TTL_SECONDS },
    );
  }

  /**
   * 記録を消す。直前の claim と同じキーへの書き込みになるため、
   * 失敗したら間を空けて再試行する。
   */
  async release(noteId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RELEASE_RETRIES; attempt++) {
      if (attempt > 0) await sleep(SAME_KEY_WRITE_INTERVAL_MS);
      try {
        await this.kv.delete(CLAIM_PREFIX + noteId);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
}
