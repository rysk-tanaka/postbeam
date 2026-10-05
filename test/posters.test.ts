import { afterEach, describe, expect, test, vi } from "vitest";
import { BufferPoster } from "../src/posters/buffer";
import { truncate } from "../src/posters/fetch";
import {
  kindFromStatus,
  type Poster,
  PosterError,
  type PostOptions,
} from "../src/posters/types";
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
      poster.post({ text: "t", imageUrls: [], truncated: false }, options),
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
      poster.post({ text: "t", imageUrls: [], truncated: false }, options),
    ).resolves.toEqual({ id: "x" });
  });
});

const textPost: OutgoingPost = { text: "t", imageUrls: [], truncated: false };
const options: PostOptions = { timeoutMs: 4000 };

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

/** 投稿が失敗したときの PosterError を返す */
async function failure(
  poster: Poster,
  post = textPost,
  postOptions = options,
): Promise<PosterError> {
  const err = await poster.post(post, postOptions).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PosterError);
  return err as PosterError;
}

/** 投稿が失敗したときの kind を返す */
async function failureKind(poster: Poster, post = textPost) {
  return (await failure(poster, post)).kind;
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
    await expect(poster.post(textPost, options)).resolves.toEqual({
      id: "b",
    });
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

  test("通信エラーは unknown", async () => {
    const poster = xPoster(async () => {
      throw new TypeError("network connection lost");
    });
    expect(await failureKind(poster)).toBe("unknown");
  });
});

describe("投稿先との通信", () => {
  const posters = [
    ["Buffer", bufferPoster],
    ["X", xPoster],
  ] as const;

  /** signal が abort されるまで応答しない fetcher */
  function hangingFetch() {
    return vi.fn<typeof fetch>(
      (_, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
  }

  /** ヘッダーの後、本文の受信中に途切れる応答 */
  function brokenBodyFetch(status: number): typeof fetch {
    return async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError("stream interrupted"));
          },
        }),
        { status },
      );
  }

  test.each(posters)(
    "%s は応答がなければ指定された上限で打ち切り、unknown にする",
    async (_, makePoster) => {
      // Node の AbortSignal.timeout は fake timers で進まないため、手で abort する
      const controller = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(controller.signal);
      const fetcher = hangingFetch();
      const pending = failure(makePoster(fetcher));
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
      expect(timeout).toHaveBeenCalledWith(options.timeoutMs);
      expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

      controller.abort(new DOMException("timed out", "TimeoutError"));
      const err = await pending;
      expect(err).toBeInstanceOf(PosterError);
      expect(err.kind).toBe("unknown");
      expect(err.message).toBe("request timed out after 4000ms");
    },
  );

  test.each(posters)(
    "%s は、指定されたタイムアウトで打ち切る",
    async (_, makePoster) => {
      const controller = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(controller.signal);
      const fetcher = hangingFetch();
      const pending = failure(makePoster(fetcher), textPost, {
        timeoutMs: 20_000,
      });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
      expect(timeout).toHaveBeenCalledWith(20_000);
      controller.abort(new DOMException("timed out", "TimeoutError"));
      expect((await pending).message).toBe("request timed out after 20000ms");
    },
  );

  test.each([4000, 20_000])(
    "本文の受信中のタイムアウトは、上限 %i ms とともにメッセージに出す",
    async (timeoutMs) => {
      const poster = bufferPoster(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new DOMException("timed out", "TimeoutError"));
              },
            }),
            { status: 200 },
          ),
      );
      const err = await failure(poster, textPost, { timeoutMs });
      expect(err.message).toBe(
        `Buffer response body could not be read (200): timed out after ${timeoutMs}ms`,
      );
    },
  );

  test.each([
    ["Buffer", 200, "unknown", bufferPoster],
    ["Buffer", 503, "unavailable", bufferPoster],
    ["X", 200, "unknown", xPoster],
    ["X", 503, "unavailable", xPoster],
  ] as const)(
    "%s で本文の受信中に途切れたら、ステータス %i から %s にする",
    async (label, status, kind, makePoster) => {
      const poster = makePoster(brokenBodyFetch(status));
      const err = await failure(poster);
      expect(err.kind).toBe(kind);
      // 途切れた原因を、メッセージとログのスタックトレースで追えるようにする
      expect(err.message).toBe(
        `${label} response body could not be read (${status}): TypeError: stream interrupted`,
      );
      expect((err.cause as Error).message).toBe("stream interrupted");
    },
  );

  test.each(posters)(
    "%s の非 JSON の応答は、そのことがメッセージでわかり、本文の先頭を detail に残す",
    async (label, makePoster) => {
      const poster = makePoster(respond(502, "<html>Bad Gateway</html>"));
      const err = await failure(poster);
      expect(err.message).toBe(`${label} returned non-JSON (502)`);
      expect(err.detail).toEqual({
        bodySnippet: "<html>Bad Gateway</html>",
      });
    },
  );

  test("非 JSON の本文は、先頭の 500 文字だけを残す", async () => {
    const poster = xPoster(respond(502, "x".repeat(600)));
    const err = await failure(poster);
    expect(err.detail).toEqual({
      bodySnippet: `${"x".repeat(500)}…`,
    });
  });

  test.each([
    ["通信エラー", new TypeError("network connection lost")],
    ["タイムアウト以外の中断", new DOMException("aborted", "AbortError")],
  ])("%s は、タイムアウトと区別できるメッセージにする", async (_, thrown) => {
    const poster = bufferPoster(async () => {
      throw thrown;
    });
    const err = await failure(poster);
    expect(err.message).toBe(`request failed: ${String(thrown)}`);
  });

  test("通信エラーは、元の例外を cause に持つ", async () => {
    const original = new TypeError("network connection lost");
    const poster = bufferPoster(async () => {
      throw original;
    });
    const err = await failure(poster);
    expect(err.cause).toBe(original);
  });
});

describe("投稿先の上限の値", () => {
  test("不正な上限は、送る前の失敗として通信エラー（unknown）と区別する", async () => {
    const fetcher = vi.fn(
      respond(200, { data: { createPost: { post: { id: "b" } } } }),
    );
    const poster = bufferPoster(fetcher);
    const err = await poster.post(textPost, { timeoutMs: -1 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(PosterError);
    expect(err).toBeInstanceOf(RangeError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("truncate", () => {
  test.each([
    ["上限以内はそのまま", "abc", 3, "abc"],
    ["上限を超えたら … を付ける", "abcd", 3, "abc…"],
    ["絵文字の途中では切らない", "a😀b", 2, "a…"],
    ["絵文字の直後なら絵文字を残す", "a😀b", 3, "a😀…"],
  ])("%s", (_, text, maxLength, expected) => {
    expect(truncate(text, maxLength)).toBe(expected);
  });
});
