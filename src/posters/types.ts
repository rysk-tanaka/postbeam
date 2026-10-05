import type { OutgoingPost } from "../transform";

export interface PostResult {
  /** 投稿先が返した投稿 ID */
  id: string;
}

export interface Poster {
  readonly name: string;
  post(post: OutgoingPost): Promise<PostResult>;
}

/**
 * 投稿に失敗したとき、投稿先で投稿されたかどうか。
 *
 * - rejected: 確実に投稿されていない。再送しても無駄
 * - unavailable: 確実に投稿されていない。再送で成功しうる
 * - unknown: 投稿されたか不明
 */
export type PosterErrorKind = "rejected" | "unavailable" | "unknown";

/** 投稿先への投稿に失敗したとき */
export class PosterError extends Error {
  constructor(
    message: string,
    readonly kind: PosterErrorKind,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PosterError";
  }
}

// 処理する前に断られたことが確実なので、再送してよいステータス。
// 408 / 425 はリクエストを処理していない、429 はレート制限、503 は受け付け停止、
// 521 / 522 / 523 は Cloudflare がオリジンに届けられなかったことを示す
const RETRYABLE_STATUSES = new Set([408, 425, 429, 503, 521, 522, 523]);

/** 2xx 以外の HTTP ステータスから、投稿されたかどうかを決める */
export function kindFromStatus(status: number): PosterErrorKind {
  if (RETRYABLE_STATUSES.has(status)) return "unavailable";
  // それ以外の 5xx は、投稿先が処理した後にゲートウェイが返した可能性がある
  if (status >= 500) return "unknown";
  return "rejected";
}

/**
 * 投稿 ID が得られなかった応答から、投稿されたかどうかを決める。
 * 2xx なのに投稿 ID がなければ、投稿されたかどうかわからない。
 */
export function kindFromResponse(res: Response): PosterErrorKind {
  return res.ok ? "unknown" : kindFromStatus(res.status);
}

/** API が返したエラーの説明を、形式が想定と違っても例外を出さずに取り出す */
export function describeErrors(errors: unknown): string {
  if (errors === undefined || errors === null) return "";
  const items: unknown[] = Array.isArray(errors) ? errors : [errors];
  return items
    .map((e) => {
      if (typeof e === "string") return e;
      const message = (e as { message?: unknown } | null)?.message;
      return typeof message === "string" ? message : JSON.stringify(e);
    })
    .join("; ");
}
