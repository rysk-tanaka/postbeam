import { afterEach, describe, expect, test, vi } from "vitest";
import { BufferPoster } from "../src/posters/buffer";
import { kindFromStatus, type Poster, PosterError } from "../src/posters/types";
import { XPoster } from "../src/posters/x";
import type { OutgoingPost } from "../src/transform";

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
  vi.restoreAllMocks();
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

const textPost: OutgoingPost = { text: "t", imageUrls: [], truncated: false };

function respond(status: number, body: unknown): typeof fetch {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return async () => new Response(raw, { status });
}

function bufferPoster(fetcher: typeof fetch) {
  return new BufferPoster("key", "ch", fetcher);
}

function xPoster(fetcher: typeof fetch) {
  return new XPoster(
    { consumerKey: "a", consumerSecret: "b", token: "c", tokenSecret: "d" },
    fetcher,
  );
}

/** 投稿が失敗したときの kind を返す */
async function failureKind(poster: Poster, post = textPost) {
  const err = await poster.post(post).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PosterError);
  return (err as PosterError).kind;
}

describe("kindFromStatus", () => {
  test.each([
    [408, "unavailable"],
    [425, "unavailable"],
    [429, "unavailable"],
    [503, "unavailable"],
    [522, "unavailable"],
    [520, "unknown"],
    [524, "unknown"],
    [500, "unknown"],
    [502, "unknown"],
    [504, "unknown"],
    [400, "rejected"],
    [401, "rejected"],
    [403, "rejected"],
  ])("%i は %s", (status, kind) => {
    expect(kindFromStatus(status)).toBe(kind);
  });
});

describe("BufferPoster のエラー分類", () => {
  test("投稿 ID があれば errors が混じっていても成功し、errors は warn ログに残す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const poster = bufferPoster(
      respond(200, {
        data: { createPost: { post: { id: "b" } } },
        errors: [{ message: "partial" }],
      }),
    );
    await expect(poster.post(textPost)).resolves.toEqual({ id: "b" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("partial"));
  });

  test.each([
    [
      "MutationError",
      200,
      { data: { createPost: { message: "Duplicate" } } },
      "rejected",
    ],
    [
      "data なしの errors（実行前のエラー）",
      200,
      { errors: [{ message: "invalid input" }] },
      "rejected",
    ],
    [
      "data: null と errors",
      200,
      { data: null, errors: [{ message: "internal" }] },
      "unknown",
    ],
    ["2xx の非 JSON", 200, "<html>ok</html>", "unknown"],
    [
      "投稿 ID も message もない",
      200,
      { data: { createPost: null } },
      "unknown",
    ],
    ["4xx", 401, { errors: [{ message: "unauthorized" }] }, "rejected"],
    ["429", 429, { errors: [{ message: "rate limited" }] }, "unavailable"],
    ["503 の非 JSON", 503, "<html>maintenance</html>", "unavailable"],
    ["503 の JSON null", 503, "null", "unavailable"],
    [
      "429 と MutationError",
      429,
      { data: { createPost: { message: "Rate limited" } } },
      "unavailable",
    ],
    [
      "500 と MutationError",
      500,
      { data: { createPost: { message: "Internal" } } },
      "unknown",
    ],
    [
      "配列でない errors",
      401,
      { errors: { message: "unauthorized" } },
      "rejected",
    ],
    ["要素が null の errors", 503, { errors: [null] }, "unavailable"],
    ["504 の非 JSON", 504, "<html>timeout</html>", "unknown"],
  ])("%s は %s", async (_, status, body, kind) => {
    expect(await failureKind(bufferPoster(respond(status, body)))).toBe(kind);
  });

  test("通信エラーは unknown", async () => {
    const poster = bufferPoster(async () => {
      throw new TypeError("network connection lost");
    });
    expect(await failureKind(poster)).toBe("unknown");
  });
});

describe("XPoster のエラー分類", () => {
  test("本文が空（画像だけ）なら投稿せずに rejected", async () => {
    const fetcher = vi.fn(respond(201, { data: { id: "x" } }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kind = await failureKind(xPoster(fetcher), {
      text: "",
      imageUrls: ["https://f/a.png"],
      truncated: false,
    });
    expect(kind).toBe("rejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    ["2xx で data.id がない", 201, {}, "unknown"],
    ["2xx の非 JSON", 201, "<html>ok</html>", "unknown"],
    ["403（重複など）", 403, { detail: "duplicate content" }, "rejected"],
    ["配列でない errors", 401, { errors: "unauthorized" }, "rejected"],
    ["429", 429, { title: "Too Many Requests" }, "unavailable"],
    ["503", 503, { title: "Service Unavailable" }, "unavailable"],
    ["500", 500, { title: "Internal Error" }, "unknown"],
    ["503 の非 JSON", 503, "<html>maintenance</html>", "unavailable"],
    ["504 の非 JSON", 504, "<html>timeout</html>", "unknown"],
    ["503 の JSON null", 503, "null", "unavailable"],
  ])("%s は %s", async (_, status, body, kind) => {
    expect(await failureKind(xPoster(respond(status, body)))).toBe(kind);
  });

  test("非 JSON の応答は、そのことがメッセージでわかる", async () => {
    const poster = xPoster(respond(502, "<html>Bad Gateway</html>"));
    await expect(poster.post(textPost)).rejects.toThrow(
      "X returned non-JSON (502)",
    );
  });

  test("通信エラーは unknown", async () => {
    const poster = xPoster(async () => {
      throw new TypeError("network connection lost");
    });
    expect(await failureKind(poster)).toBe("unknown");
  });
});
