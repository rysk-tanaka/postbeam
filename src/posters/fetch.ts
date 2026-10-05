import { kindFromResponse, PosterError } from "./types";

const NON_JSON_SNIPPET_LENGTH = 500;

/** 長さの上限を超えたら切り詰め、切り詰めたことがわかるよう末尾に … を付ける */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  // サロゲートペアの途中で切ると、絵文字などが壊れた文字として残る
  const code = text.charCodeAt(maxLength - 1);
  const splitsPair = code >= 0xd800 && code <= 0xdbff;
  const end = splitsPair ? maxLength - 1 : maxLength;
  return `${text.slice(0, end)}…`;
}

/**
 * グローバルの fetch を呼ぶラッパー。
 *
 * Workers では fetch をプロパティとして保持して `this.fetcher(...)` のように
 * 呼ぶと「Illegal invocation」になるため、必ずこの関数経由で既定値にする。
 */
export const globalFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * 投稿先へリクエストを送る。
 * 通信エラーとタイムアウトは、投稿先が処理したかどうかわからないため unknown として投げる。
 */
async function sendRequest(
  fetcher: typeof fetch,
  input: string,
  // signal はタイムアウトのために上書きするため、呼び出し側からは渡させない
  init: RequestInit & { signal?: never },
  timeoutMs: number,
): Promise<Response> {
  // 不正な上限による例外は、送る前の失敗なので通信エラー（unknown）に包まない
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetcher(input, { ...init, signal });
  } catch (err) {
    const message = isTimeout(err)
      ? `request timed out after ${timeoutMs}ms`
      : `request failed: ${String(err)}`;
    throw new PosterError(message, "unknown", undefined, undefined, err);
  }
}

function isTimeout(err: unknown): boolean {
  // DOMException が Error を継承しない環境もあるため、name だけで判定する
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}

/**
 * 応答の本文を JSON として読む。
 * タイムアウトなどで本文の受信中に途切れたのか、JSON でなかったのかをメッセージで区別する。
 */
async function readJson(
  res: Response,
  label: string,
  timeoutMs: number,
): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new PosterError(
      `${label} response body could not be read (${res.status}): ${isTimeout(err) ? `timed out after ${timeoutMs}ms` : String(err)}`,
      kindFromResponse(res),
      res.status,
      undefined,
      err,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    // Cloudflare のチャレンジページやメンテナンス画面などを、後からログで調べられるようにする
    throw new PosterError(
      `${label} returned non-JSON (${res.status})`,
      kindFromResponse(res),
      res.status,
      { bodySnippet: truncate(text, NON_JSON_SNIPPET_LENGTH) },
    );
  }
}

/**
 * 投稿先へリクエストを送り、応答を JSON として読む。
 * 通信と本文の受信に同じ上限をかけ、失敗のメッセージにもその上限を使う。
 */
export async function requestJson(
  fetcher: typeof fetch,
  request: {
    /** エラーのメッセージに出す投稿先の名前 */
    label: string;
    url: string;
    init: RequestInit & { signal?: never };
    timeoutMs: number;
  },
): Promise<{ res: Response; body: unknown }> {
  const { label, url, init, timeoutMs } = request;
  const res = await sendRequest(fetcher, url, init, timeoutMs);
  const body = await readJson(res, label, timeoutMs);
  return { res, body };
}
