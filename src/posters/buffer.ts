import type { OutgoingPost } from "../transform";
import { globalFetch, sendRequest } from "./fetch";
import {
  describeErrors,
  kindFromResponse,
  kindFromStatus,
  type Poster,
  PosterError,
  type PostResult,
} from "./types";

export const BUFFER_API_URL = "https://api.buffer.com";

/**
 * createPost の mutation を組み立てる。
 * Buffer は `assets: null` を受け付けない（「Argument "input" has invalid value」になる）ため、
 * 画像がないときは assets を変数ごと含めない。
 */
export function createPostMutation(withAssets: boolean): string {
  const assetsVar = withAssets ? ", $assets: [AssetInput!]!" : "";
  const assetsField = withAssets ? "\n    assets: $assets" : "";
  return `
mutation CreatePost($text: String!, $channelId: ChannelId!${assetsVar}) {
  createPost(input: {
    text: $text
    channelId: $channelId
    schedulingType: automatic
    mode: shareNow${assetsField}
  }) {
    ... on PostActionSuccess { post { id } }
    ... on MutationError { message }
  }
}`;
}

interface GraphQLResponse {
  data?: {
    createPost?: { post?: { id: string }; message?: string } | null;
  } | null;
  // 配列のはずだが、ゲートウェイなどが別の形式で返すこともある
  errors?: unknown;
}

/**
 * Buffer の GraphQL API ですぐに投稿する。
 * API キーは posts:write の権限があれば足りる。
 * https://developers.buffer.com/
 */
export class BufferPoster implements Poster {
  readonly name = "buffer";

  constructor(
    private readonly apiKey: string,
    private readonly channelId: string,
    private readonly fetcher: typeof fetch = globalFetch,
  ) {}

  async post(post: OutgoingPost): Promise<PostResult> {
    const assets = post.imageUrls.map((url) => ({ image: { url } }));
    const withAssets = assets.length > 0;
    const res = await sendRequest(this.fetcher, BUFFER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: createPostMutation(withAssets),
        variables: {
          text: post.text,
          channelId: this.channelId,
          ...(withAssets ? { assets } : {}),
        },
      }),
    });

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new PosterError(
        `Buffer returned non-JSON (${res.status})`,
        kindFromResponse(res),
        res.status,
      );
    }
    const json: GraphQLResponse =
      typeof parsed === "object" && parsed !== null ? parsed : {};

    // 投稿 ID が返っていれば、errors が混じっていても投稿は済んでいる
    const result = json.data?.createPost;
    if (result?.post?.id) {
      // 投稿は済んでいるが、画像が付かなかったなどの劣化を後から追えるようにする
      const partialErrors = describeErrors(json.errors);
      if (partialErrors) {
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "buffer returned errors with post id",
            postId: result.post.id,
            errors: partialErrors,
          }),
        );
      }
      return { id: result.post.id };
    }

    const msg = describeErrors(json.errors) || String(result?.message ?? "");
    // 429 や 503 と一緒に MutationError が返っても、一時的な失敗として再送させる
    if (!res.ok) {
      throw new PosterError(
        `Buffer API error (${res.status}): ${msg}`,
        kindFromStatus(res.status),
        res.status,
        json,
      );
    }
    if (result?.message) {
      throw new PosterError(
        `Buffer rejected the post: ${result.message}`,
        "rejected",
        res.status,
        json,
      );
    }
    // GraphQL では、構文や検証のエラーで実行前に失敗した応答は data を含まない
    const isRequestError =
      Array.isArray(json.errors) && json.errors.length > 0 && !("data" in json);
    throw new PosterError(
      `Buffer API error (${res.status}): ${msg || "no post id"}`,
      isRequestError ? "rejected" : "unknown",
      res.status,
      json,
    );
  }
}
