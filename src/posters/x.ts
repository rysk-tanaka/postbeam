import { type OAuth1Credentials, signOAuth1 } from "../oauth1";
import type { OutgoingPost } from "../transform";
import { globalFetch, requestJson } from "./fetch";
import {
  describeErrors,
  kindFromResponse,
  type Poster,
  PosterError,
  type PostOptions,
  type PostResult,
} from "./types";

export const X_CREATE_POST_URL = "https://api.x.com/2/tweets";

interface XCreateResponse {
  data?: { id: string; text: string };
  title?: string;
  detail?: string;
  // 配列のはずだが、ゲートウェイなどが別の形式で返すこともある
  errors?: unknown;
}

/**
 * X API v2 に OAuth 1.0a で直接投稿する（予備の投稿先）。
 *
 * 現時点では本文のみ対応で、画像は添付しない。
 * 従量課金のため、URL を含む投稿は通常より高くなる点に注意。
 */
export class XPoster implements Poster {
  readonly name = "x";

  constructor(
    private readonly creds: OAuth1Credentials,
    private readonly fetcher: typeof fetch = globalFetch,
  ) {}

  async post(post: OutgoingPost, options: PostOptions): Promise<PostResult> {
    if (post.imageUrls.length > 0) {
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "x poster does not upload media yet; posting text only",
          images: post.imageUrls.length,
        }),
      );
    }
    if (!post.text) {
      throw new PosterError("X requires text when no media", "rejected");
    }

    const { header } = await signOAuth1(this.creds, {
      method: "POST",
      url: X_CREATE_POST_URL,
    });
    const { res, body: parsed } = await requestJson(this.fetcher, {
      label: "X",
      url: X_CREATE_POST_URL,
      init: {
        method: "POST",
        headers: { Authorization: header, "Content-Type": "application/json" },
        body: JSON.stringify({ text: post.text }),
      },
      timeoutMs: options.timeoutMs,
    });
    const json: XCreateResponse =
      typeof parsed === "object" && parsed !== null ? parsed : {};
    if (res.ok && json.data?.id) return { id: json.data.id };
    const msg =
      json.detail ??
      json.title ??
      (describeErrors(json.errors) || "no post id in response");
    throw new PosterError(
      `X API error (${res.status}): ${msg}`,
      kindFromResponse(res),
      res.status,
      json,
    );
  }
}
