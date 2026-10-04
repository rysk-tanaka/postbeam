import type { OutgoingPost } from "../transform";

export interface PostResult {
  /** 投稿先が返した投稿 ID */
  id: string;
}

export interface Poster {
  readonly name: string;
  post(post: OutgoingPost): Promise<PostResult>;
}

/** 投稿先の API がエラーを返したとき */
export class PosterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PosterError";
  }
}
