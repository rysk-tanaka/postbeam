import { afterEach, describe, expect, test, vi } from "vitest";
import { BufferPoster } from "../src/posters/buffer";
import { XPoster } from "../src/posters/x";

/**
 * Workers の fetch は、グローバル以外を this にして呼ぶと
 * 「Illegal invocation」になる。その挙動を再現するスタブ。
 */
function strictThisFetch(body: unknown, status = 200) {
  return vi.fn(function (this: unknown) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Illegal invocation");
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("既定の fetch の呼び出し方", () => {
  test("BufferPoster はグローバルの fetch を正しく呼ぶ", async () => {
    vi.stubGlobal(
      "fetch",
      strictThisFetch({ data: { createPost: { post: { id: "b" } } } }),
    );
    const poster = new BufferPoster("key", "ch");
    await expect(
      poster.post({ text: "t", imageUrls: [], truncated: false }),
    ).resolves.toEqual({ id: "b" });
  });

  test("XPoster はグローバルの fetch を正しく呼ぶ", async () => {
    vi.stubGlobal("fetch", strictThisFetch({ data: { id: "x", text: "t" } }));
    const poster = new XPoster({
      consumerKey: "a",
      consumerSecret: "b",
      token: "c",
      tokenSecret: "d",
    });
    await expect(
      poster.post({ text: "t", imageUrls: [], truncated: false }),
    ).resolves.toEqual({ id: "x" });
  });
});
