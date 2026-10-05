import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../src/config";
import { handleRequest } from "../src/index";
import { signOAuth1 } from "../src/oauth1";
import { BUFFER_API_URL, BufferPoster } from "../src/posters/buffer";
import { X_CREATE_POST_URL } from "../src/posters/x";
import { createMemoryKv, makeNote, makePayload } from "./helpers";

const SECRET = "s3cret";

const bufferEnv: Env = {
  MISSKEY_HOOK_SECRET: SECRET,
  BUFFER_API_KEY: "buffer-key",
  BUFFER_CHANNEL_ID: "channel-1",
};

function request(body: unknown, secret = SECRET, method = "POST"): Request {
  return new Request("https://postbeam.example/", {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Misskey-Hook-Secret": secret,
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const bufferOk = { data: { createPost: { post: { id: "buf-1" } } } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleRequest", () => {
  test("POST 以外は 405", async () => {
    const res = await handleRequest(request(null, SECRET, "GET"), bufferEnv);
    expect(res.status).toBe(405);
  });

  test("secret が違えば 401 で、投稿しない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = mockFetch(200, bufferOk);
    const res = await handleRequest(
      request(makePayload(), "wrong"),
      bufferEnv,
      fetcher,
    );
    expect(res.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("不正な JSON は 400", async () => {
    const req = new Request("https://postbeam.example/", {
      method: "POST",
      headers: { "X-Misskey-Hook-Secret": SECRET },
      body: "{",
    });
    expect((await handleRequest(req, bufferEnv)).status).toBe(400);
  });

  test("note 以外のイベントはスキップ", async () => {
    const res = await handleRequest(
      request(makePayload(undefined, { type: "followed" })),
      bufferEnv,
    );
    expect(await res.json()).toEqual({ skipped: "event:followed" });
  });

  test("Misskey のテスト送信（dummy ノート）は投稿しない", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetcher = mockFetch(200, bufferOk);
    const res = await handleRequest(
      request(makePayload(makeNote({ id: "dummy-note-1" }))),
      bufferEnv,
      fetcher,
    );
    expect(await res.json()).toEqual({ skipped: "test-event" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("フィルタで除外されたノートは 200 でスキップ", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await handleRequest(
      request(makePayload(makeNote({ visibility: "followers" }))),
      bufferEnv,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "visibility:followers" });
  });

  test("Buffer にすぐ投稿する（画像付き）", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetcher = mockFetch(200, bufferOk);
    const note = makeNote({
      text: "**できた**",
      files: [
        {
          id: "f",
          type: "image/png",
          url: "https://f/a.png",
          isSensitive: false,
        },
      ],
    });
    const res = await handleRequest(
      request(makePayload(note)),
      bufferEnv,
      fetcher,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posted: "buf-1", poster: "buffer" });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(BUFFER_API_URL);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer buffer-key",
    );
    const sent = JSON.parse(String(init?.body));
    expect(sent.query).toContain("mode: shareNow");
    expect(sent.variables).toEqual({
      text: "できた",
      channelId: "channel-1",
      assets: [{ image: { url: "https://f/a.png" } }],
    });
    expect(sent.query).toContain("$assets: [AssetInput!]!");
  });

  test("画像がないときは assets を送らない（Buffer は null を受け付けない）", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetcher = mockFetch(200, bufferOk);
    await handleRequest(request(makePayload()), bufferEnv, fetcher);

    const [, init] = fetcher.mock.calls[0] ?? [];
    const sent = JSON.parse(String(init?.body));
    expect(sent.query).not.toContain("assets");
    expect(sent.variables).toEqual({
      text: "こんにちは",
      channelId: "channel-1",
    });
  });

  test("Buffer が投稿を拒否したら 422（Misskey は再送しない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = mockFetch(200, {
      data: { createPost: { message: "Duplicate post" } },
    });
    const res = await handleRequest(request(makePayload()), bufferEnv, fetcher);
    expect(res.status).toBe(422);
  });

  test("投稿先の 5xx は 502（Misskey が再送する）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = mockFetch(503, { errors: [{ message: "unavailable" }] });
    const res = await handleRequest(request(makePayload()), bufferEnv, fetcher);
    expect(res.status).toBe(502);
  });

  test("投稿されたか不明な応答は 422（KV がなくても再送させない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = mockFetch(200, { data: { createPost: null } });
    const res = await handleRequest(request(makePayload()), bufferEnv, fetcher);
    expect(res.status).toBe(422);
  });

  test("シークレット不足は 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleRequest(request(makePayload()), {
      MISSKEY_HOOK_SECRET: SECRET,
    });
    expect(res.status).toBe(500);
  });

  test("POSTER=x では X API に OAuth 1.0a で投稿する", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetcher = mockFetch(201, { data: { id: "x-1", text: "こんにちは" } });
    const env: Env = {
      MISSKEY_HOOK_SECRET: SECRET,
      POSTER: "x",
      X_API_KEY: "ck",
      X_API_SECRET: "cs",
      X_ACCESS_TOKEN: "at",
      X_ACCESS_SECRET: "as",
    };
    const res = await handleRequest(request(makePayload()), env, fetcher);
    expect(await res.json()).toEqual({ posted: "x-1", poster: "x" });

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(X_CREATE_POST_URL);
    const authorization = new Headers(init?.headers).get("Authorization") ?? "";
    expect(authorization).toMatch(/oauth_token="at"/);
    // シークレットの取り違えは型では防げないので、同じ鍵で作った署名と比べる
    const nonce = authorization.match(/oauth_nonce="([^"]+)"/)?.[1] ?? "";
    const timestamp = authorization.match(/oauth_timestamp="(\d+)"/)?.[1];
    const expected = await signOAuth1(
      {
        consumerKey: "ck",
        consumerSecret: "cs",
        token: "at",
        tokenSecret: "as",
      },
      {
        method: "POST",
        url: X_CREATE_POST_URL,
        nonce: decodeURIComponent(nonce),
        timestamp: Number(timestamp),
      },
    );
    expect(authorization).toBe(expected.header);
    expect(JSON.parse(String(init?.body))).toEqual({ text: "こんにちは" });
  });

  test("POSTER=x で画像だけのノートは 422（再送しても投稿できない）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = mockFetch(201, { data: { id: "x-1", text: "" } });
    const note = makeNote({
      text: null,
      files: [
        {
          id: "f",
          type: "image/png",
          url: "https://f/a.png",
          isSensitive: false,
        },
      ],
    });
    const env: Env = {
      MISSKEY_HOOK_SECRET: SECRET,
      POSTER: "x",
      X_API_KEY: "ck",
      X_API_SECRET: "cs",
      X_ACCESS_TOKEN: "at",
      X_ACCESS_SECRET: "as",
    };
    const res = await handleRequest(request(makePayload(note)), env, fetcher);
    expect(res.status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("handleRequest（KV による重複投稿の防止）", () => {
  const NOTE_ID = makeNote().id;
  const CLAIM_KEY = `claimed:${NOTE_ID}`;

  function setup(initial: Record<string, string> = {}) {
    const memory = createMemoryKv(initial);
    const env: Env = { ...bufferEnv, POSTED_NOTES: memory.kv };
    const send = (fetcher: typeof fetch) =>
      handleRequest(request(makePayload()), env, fetcher);
    return { memory, env, send };
  }

  function throwingFetch() {
    return vi.fn<typeof fetch>(async () => {
      throw new TypeError("network connection lost");
    });
  }

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("記録のあるノートは投稿しない", async () => {
    const { send } = setup({ [CLAIM_KEY]: "{}" });
    const fetcher = mockFetch(200, bufferOk);
    const res = await send(fetcher);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "duplicate" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("投稿の前に TTL 付きで記録し、成功後も残す", async () => {
    const { memory, send } = setup();
    const ok = mockFetch(200, bufferOk);
    // 投稿中に届いた再送を防げるよう、投稿先を呼ぶ時点で記録がある
    const fetcher = vi.fn<typeof fetch>(async (...args) => {
      expect(memory.store.has(CLAIM_KEY)).toBe(true);
      return ok(...args);
    });
    const first = await send(fetcher);
    expect(first.status).toBe(200);
    expect(memory.store.has(CLAIM_KEY)).toBe(true);
    expect(memory.ttls.get(CLAIM_KEY)).toBe(7 * 24 * 60 * 60);

    const second = await send(fetcher);
    expect(await second.json()).toEqual({ skipped: "duplicate" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["4xx", 400, { errors: [{ message: "bad request" }] }],
    ["MutationError", 200, { data: { createPost: { message: "Duplicate" } } }],
  ])("拒否（%s）は 422 で、記録は消さずに残す", async (_, status, body) => {
    const { memory, send } = setup();
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const res = await send(mockFetch(status, body));
    expect(res.status).toBe(422);
    expect(memory.store.has(CLAIM_KEY)).toBe(true);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test.each([503, 429])(
    "%i は 502 で記録を消し、再送で投稿し直す",
    async (status) => {
      const { memory, send } = setup();
      const first = await send(
        mockFetch(status, { errors: [{ message: "busy" }] }),
      );
      expect(first.status).toBe(502);
      expect(memory.store.has(CLAIM_KEY)).toBe(false);

      const fetcher = mockFetch(200, bufferOk);
      const second = await send(fetcher);
      expect(await second.json()).toEqual({
        posted: "buf-1",
        poster: "buffer",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ["通信エラー", () => throwingFetch()],
    ["504", () => mockFetch(504, { errors: [{ message: "timeout" }] })],
    ["2xx の不正な応答", () => mockFetch(200, { data: null })],
  ])(
    "結果が不明（%s）なら 422 で記録を残し、届いた再送も投稿しない",
    async (_, makeFetcher) => {
      const { memory, send } = setup();
      const fetcher = makeFetcher();
      const first = await send(fetcher);
      expect(first.status).toBe(422);
      expect(memory.store.has(CLAIM_KEY)).toBe(true);

      // Misskey 側のタイムアウトなどで再送が届いた場合
      const second = await send(fetcher);
      expect(await second.json()).toEqual({ skipped: "duplicate" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ["get", "claimed:"],
    ["put", "claimed:"],
  ] as const)(
    "KV の %s が失敗しても、重複を確認せずに投稿する",
    async (method, keyPrefix) => {
      const { memory, send } = setup();
      memory.fail(method, { keyPrefix });
      const fetcher = mockFetch(200, bufferOk);
      const res = await send(fetcher);
      expect(await res.json()).toEqual({ posted: "buf-1", poster: "buffer" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  test("記録の書き込みに失敗しても、確実な失敗のあとは削除を試みる", async () => {
    const { memory, send } = setup();
    memory.fail("put", { keyPrefix: "claimed:" });
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  test("記録の書き込みと削除が両方失敗したら、記録はおそらくないので 502 のまま", async () => {
    vi.useFakeTimers();
    const { memory, send } = setup();
    memory.fail("put", { keyPrefix: "claimed:" });
    memory.fail("delete");
    const pending = send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(502);
  });

  test("記録の書き込みに失敗しても、結果が不明なら記録の削除を試みない", async () => {
    const { memory, send } = setup();
    memory.fail("put", { keyPrefix: "claimed:" });
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const res = await send(throwingFetch());
    expect(res.status).toBe(422);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("重複を確認できなかったときは、記録の削除を試みずに 502 を返す", async () => {
    const { memory, send } = setup();
    memory.fail("get");
    memory.fail("delete");
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("記録の削除は、同じキーへの書き込み制限に合わせて 1 秒以上空けて再試行する", async () => {
    vi.useFakeTimers();
    const { memory, send } = setup();
    memory.fail("delete", { times: 2 });
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const pending = send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await vi.advanceTimersByTimeAsync(999);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(deleteSpy).toHaveBeenCalledTimes(3);
    expect((await pending).status).toBe(502);
    expect(memory.store.has(CLAIM_KEY)).toBe(false);
  });

  test("記録の削除が 1 回失敗しても、再試行して消す", async () => {
    vi.useFakeTimers();
    const { memory, send } = setup();
    memory.fail("delete", { times: 1 });
    const pending = send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(502);
    expect(memory.store.has(CLAIM_KEY)).toBe(false);
  });

  test("記録の削除がすべて失敗したら、再送しても無駄なので 422 にする", async () => {
    vi.useFakeTimers();
    const { memory, send } = setup();
    memory.fail("delete");
    const pending = send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(422);
    expect(memory.store.has(CLAIM_KEY)).toBe(true);
  });

  test("投稿中の想定外の例外は 422 で記録を残す", async () => {
    const { memory, send } = setup();
    vi.spyOn(BufferPoster.prototype, "post").mockRejectedValue(
      new TypeError("unexpected shape"),
    );
    const res = await send(mockFetch(200, bufferOk));
    expect(res.status).toBe(422);
    expect(memory.store.has(CLAIM_KEY)).toBe(true);
  });

  test("本文が空になるノートは投稿せず、KV にも記録しない", async () => {
    const memory = createMemoryKv();
    const fetcher = mockFetch(200, bufferOk);
    const res = await handleRequest(
      request(makePayload(makeNote({ text: ":blob:" }))),
      { ...bufferEnv, POSTED_NOTES: memory.kv },
      fetcher,
    );
    expect(await res.json()).toEqual({ skipped: "empty" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(memory.store.size).toBe(0);
  });

  function loggedLines(method: "info" | "error", msg: string) {
    return vi
      .mocked(console[method])
      .mock.calls.map(([line]) => JSON.parse(String(line)))
      .filter((line) => line.msg === msg);
  }

  test.each([
    ["KV あり", true, "claimed"],
    ["KV なし", false, "disabled"],
  ])("投稿のログに重複の防止の状態を残す（%s）", async (_, hasKv, expected) => {
    const memory = createMemoryKv();
    const env: Env = hasKv
      ? { ...bufferEnv, POSTED_NOTES: memory.kv }
      : bufferEnv;
    await handleRequest(request(makePayload()), env, mockFetch(200, bufferOk));
    expect(loggedLines("info", "posted")[0]?.dedupe).toBe(expected);
  });

  test("投稿に失敗したときのログにも重複の防止の状態を残す", async () => {
    const { memory, send } = setup();
    memory.fail("get");
    await send(mockFetch(400, { errors: [{ message: "bad request" }] }));
    expect(loggedLines("error", "post failed")[0]?.dedupe).toBe("unchecked");
  });

  test("シークレット不足は 500 で、KV に何も記録しない", async () => {
    const memory = createMemoryKv();
    const res = await handleRequest(request(makePayload()), {
      MISSKEY_HOOK_SECRET: SECRET,
      POSTED_NOTES: memory.kv,
    });
    expect(res.status).toBe(500);
    expect(memory.store.size).toBe(0);
  });
});
