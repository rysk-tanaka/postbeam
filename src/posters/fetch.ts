import { PosterError } from "./types";

/**
 * グローバルの fetch を呼ぶラッパー。
 *
 * Workers では fetch をプロパティとして保持して `this.fetcher(...)` のように
 * 呼ぶと「Illegal invocation」になるため、必ずこの関数経由で既定値にする。
 */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * 投稿先へリクエストを送る。
 * 通信エラーは、投稿先が処理したかどうかわからないため unknown として投げる。
 */
export async function sendRequest(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(input, init);
  } catch (err) {
    throw new PosterError(`request failed: ${String(err)}`, "unknown");
  }
}
