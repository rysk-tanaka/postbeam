import type { OutgoingPost } from "../transform";
import { globalFetch } from "./fetch";
import { type Poster, PosterError, type PostResult } from "./types";

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
  errors?: { message: string }[];
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
    const res = await this.fetcher(BUFFER_API_URL, {
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

    let json: GraphQLResponse;
    try {
      json = (await res.json()) as GraphQLResponse;
    } catch {
      throw new PosterError(
        `Buffer returned non-JSON (${res.status})`,
        res.status,
      );
    }

    if (!res.ok || json.errors?.length) {
      const msg = json.errors?.map((e) => e.message).join("; ") ?? "";
      throw new PosterError(
        `Buffer API error (${res.status}): ${msg}`,
        res.status,
        json,
      );
    }
    const result = json.data?.createPost;
    if (result?.post?.id) return { id: result.post.id };
    throw new PosterError(
      `Buffer rejected the post: ${result?.message ?? "unknown error"}`,
      res.status,
      json,
    );
  }
}
