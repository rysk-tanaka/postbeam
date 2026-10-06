import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../src/config";
import worker, { handleRequest } from "../src/index";
import { signOAuth1 } from "../src/oauth1";
import { BUFFER_API_URL, BufferPoster } from "../src/posters/buffer";
import { PosterError } from "../src/posters/types";
import { X_CREATE_POST_URL } from "../src/posters/x";
import {
  createContext,
  createMemoryKv,
  type MemoryKv,
  makeNote,
  makePayload,
  type TestContext,
} from "./helpers";

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

/** waitUntil の中身を確かめないテスト用 */
const ctx = () => createContext().ctx;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleRequest", () => {
  test("POST 以外は 405", async () => {
    const res = await handleRequest(
      request(null, SECRET, "GET"),
      bufferEnv,
      ctx(),
    );
    expect(res.status).toBe(405);
  });

  test("secret が違えば 401 で、投稿しない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = mockFetch(200, bufferOk);
    const res = await handleRequest(
      request(makePayload(), "wrong"),
      bufferEnv,
      ctx(),
      fetcher,
    );
    expect(res.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("secret と長さが同じでも中身が違えば 401 で、投稿しない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = mockFetch(200, bufferOk);
    const res = await handleRequest(
      request(makePayload(), "s3creT"),
      bufferEnv,
      ctx(),
      fetcher,
    );
    expect(res.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("secret が未登録なら、空のヘッダーでも 401 で、投稿しない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = mockFetch(200, bufferOk);
    const { MISSKEY_HOOK_SECRET: _, ...envWithoutSecret } = bufferEnv;
    const res = await handleRequest(
      request(makePayload(), ""),
      envWithoutSecret as Env,
      ctx(),
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
    expect((await handleRequest(req, bufferEnv, ctx())).status).toBe(400);
  });

  test.each([
    ["id がない", {}],
    ["id が文字列でない", { id: 1 }],
    ["オブジェクトでない", "note"],
  ])("ノートの %s payload は 400（再送させない）", async (_, note) => {
    const fetcher = mockFetch(200, bufferOk);
    const res = await handleRequest(
      request({ type: "note", body: { note } }),
      bufferEnv,
      ctx(),
      fetcher,
    );
    expect(res.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("ノートが null の payload は、これまでどおりスキップする", async () => {
    const res = await handleRequest(
      request({ type: "note", body: { note: null } }),
      bufferEnv,
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "event:note" });
  });

  test("note 以外のイベントはスキップ", async () => {
    const res = await handleRequest(
      request(makePayload(undefined, { type: "followed" })),
      bufferEnv,
      ctx(),
    );
    expect(await res.json()).toEqual({ skipped: "event:followed" });
  });

  test("Misskey のテスト送信（dummy ノート）は投稿しない", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetcher = mockFetch(200, bufferOk);
    const res = await handleRequest(
      request(makePayload(makeNote({ id: "dummy-note-1" }))),
      bufferEnv,
      ctx(),
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
      ctx(),
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
      ctx(),
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
    await handleRequest(request(makePayload()), bufferEnv, ctx(), fetcher);

    const [, init] = fetcher.mock.calls[0] ?? [];
    const sent = JSON.parse(String(init?.body));
    expect(sent.query).not.toContain("assets");
    expect(sent.variables).toEqual({
      text: "こんにちは",
      channelId: "channel-1",
    });
  });

  test.each([
    [
      "payload の server を MISSKEY_URL より優先する",
      { server: "https://misskey.example/" },
      { MISSKEY_URL: "https://mk.example" },
      {},
      "https://misskey.example/notes/a1b2c3",
    ],
    [
      "server がなければ MISSKEY_URL を使う",
      { server: undefined },
      { MISSKEY_URL: "https://mk.example/" },
      {},
      "https://mk.example/notes/a1b2c3",
    ],
    [
      "どちらもなければノートの url を使う",
      { server: undefined },
      {},
      { url: "https://remote.example/notes/xyz" },
      "https://remote.example/notes/xyz",
    ],
  ])(
    "元ノートへのリンクは、%s",
    async (_, payloadOverrides, envOverrides, noteOverrides, expected) => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      const fetcher = mockFetch(200, bufferOk);
      const env: Env = { ...bufferEnv, APPEND_LINK: "always", ...envOverrides };
      const note = makeNote(noteOverrides);
      await handleRequest(
        request(makePayload(note, payloadOverrides)),
        env,
        ctx(),
        fetcher,
      );

      const [, init] = fetcher.mock.calls[0] ?? [];
      const sent = JSON.parse(String(init?.body));
      expect(sent.variables.text).toBe(`こんにちは\n${expected}`);
    },
  );

  test("Buffer が投稿を拒否したら 422（Misskey は再送しない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = mockFetch(200, {
      data: { createPost: { message: "Duplicate post" } },
    });
    const res = await handleRequest(
      request(makePayload()),
      bufferEnv,
      ctx(),
      fetcher,
    );
    expect(res.status).toBe(422);
  });

  test("投稿先の 5xx は 502（Misskey が再送する）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = mockFetch(503, { errors: [{ message: "unavailable" }] });
    const res = await handleRequest(
      request(makePayload()),
      bufferEnv,
      ctx(),
      fetcher,
    );
    expect(res.status).toBe(502);
  });

  test("投稿されたか不明な応答は 422（KV がなくても再送させない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = mockFetch(200, { data: { createPost: null } });
    const res = await handleRequest(
      request(makePayload()),
      bufferEnv,
      ctx(),
      fetcher,
    );
    expect(res.status).toBe(422);
  });

  test("シークレット不足は 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await handleRequest(
      request(makePayload()),
      {
        MISSKEY_HOOK_SECRET: SECRET,
      },
      ctx(),
    );
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
    const res = await handleRequest(
      request(makePayload()),
      env,
      ctx(),
      fetcher,
    );
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
    const res = await handleRequest(
      request(makePayload(note)),
      env,
      ctx(),
      fetcher,
    );
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
    const contexts: TestContext[] = [];
    const send = (fetcher: typeof fetch) => {
      const context = createContext();
      contexts.push(context);
      return handleRequest(request(makePayload()), env, context.ctx, fetcher);
    };
    /** 応答の後も waitUntil で続く記録の削除の完了を待つ */
    const settle = async () => {
      // 削除の前の待ちを、実時間で待たずに進める
      if (vi.isFakeTimers()) await vi.runAllTimersAsync();
      await Promise.all(contexts.map((c) => c.settle()));
    };
    return { memory, env, send, settle, contexts };
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
    // 書いた記録の日時を、再送のスキップのログで読める
    const [skipped] = loggedLines("info", "skipped");
    expect(skipped?.claimedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
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
      vi.useFakeTimers();
      const { memory, send, settle } = setup();
      const first = await send(
        mockFetch(status, { errors: [{ message: "busy" }] }),
      );
      expect(first.status).toBe(502);
      await settle();
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
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    memory.fail("put", { keyPrefix: "claimed:" });
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    // 例外になっても保存されていることがあるため、書き込み制限の間隔は空ける
    await vi.advanceTimersByTimeAsync(1099);
    expect(deleteSpy).not.toHaveBeenCalled();
    await settle();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    // 書き込みは終わっていたので、警告は出さない
    expect(
      loggedLines("warn", "released claim before the claim write finished"),
    ).toEqual([]);
  });

  test("打ち切った書き込みが後から届いても、その後に削除して記録を残さない", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    const put = memory.kv.put.bind(memory.kv);
    let finishPut = () => {};
    // 書き込みが 1 秒の上限を過ぎても終わらず、後から保存されることにする
    vi.spyOn(memory.kv, "put").mockImplementation(
      (...args) =>
        new Promise<void>((resolve) => {
          finishPut = () => {
            void put(...args).then(resolve);
          };
        }),
    );
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const pending = send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(502);
    expect(loggedLines("error", "post failed")[0]?.dedupe).toBe("claim-failed");

    // 書き込みが終わるまでは削除しない
    await vi.advanceTimersByTimeAsync(3000);
    expect(deleteSpy).not.toHaveBeenCalled();
    finishPut();
    await vi.advanceTimersByTimeAsync(1099);
    expect(deleteSpy).not.toHaveBeenCalled();
    await settle();
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(memory.store.has(CLAIM_KEY)).toBe(false);
    // 書き込みの完了を確かめてから消したので、警告は出さない
    expect(
      loggedLines("warn", "released claim before the claim write finished"),
    ).toEqual([]);
  });

  test("打ち切った書き込みが 5 秒待っても終わらなければ、消してから警告を残す", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    vi.spyOn(memory.kv, "put").mockReturnValue(new Promise<never>(() => {}));
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const pending = send(mockFetch(503, { errors: [{ message: "busy" }] }));
    // 投稿の前の記録の書き込みが、1 秒の上限まで待つ
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(502);

    // 書き込みを 5 秒待ってから、書き込み制限の 1.1 秒を空けて消す
    await vi.advanceTimersByTimeAsync(5000 + 1099);
    expect(deleteSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    await settle();
    expect(
      loggedLines("warn", "released claim before the claim write finished"),
    ).toEqual([
      expect.objectContaining({
        noteId: NOTE_ID,
        dedupe: "claim-failed",
        kind: "unavailable",
        status: 503,
      }),
    ]);
    // 再送で投稿し直されるかはわからないので、retries は付けない
    expect(
      loggedLines("warn", "released claim before the claim write finished")[0],
    ).not.toHaveProperty("retries");
    expect(memory.store.has(CLAIM_KEY)).toBe(false);
  });

  test("削除が返らなければ打ち切って再試行し、使い切ったらログに残す", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    vi.spyOn(memory.kv, "delete").mockReturnValue(new Promise<never>(() => {}));
    await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await settle();
    expect(memory.kv.delete).toHaveBeenCalledTimes(3);
    expect(loggedLines("error", "failed to release claim")).toEqual([
      expect.objectContaining({
        error: expect.stringContaining("kv delete timed out after 2000ms"),
      }),
    ]);
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

  test("記録の削除の完了を待たずに応答し、その後も 1 秒以上空けて削除と再試行をする", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    memory.fail("delete", { times: 2 });
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    expect(memory.store.has(CLAIM_KEY)).toBe(true);

    // 直前の記録の書き込みと同じキーなので、最初の削除の前から 1 秒以上空ける
    await vi.advanceTimersByTimeAsync(999);
    expect(deleteSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(101);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await settle();
    expect(deleteSpy).toHaveBeenCalledTimes(3);
    expect(memory.store.has(CLAIM_KEY)).toBe(false);
  });

  test("記録の削除が 1 回失敗しても、再試行して消す", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    memory.fail("delete", { times: 1 });
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    await vi.runAllTimersAsync();
    await settle();
    expect(memory.store.has(CLAIM_KEY)).toBe(false);
  });

  test("記録の削除がすべて失敗しても 502 のままで、ログに残す", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    memory.fail("delete");
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    await vi.runAllTimersAsync();
    await settle();
    expect(memory.store.has(CLAIM_KEY)).toBe(true);
    expect(loggedLines("error", "failed to release claim")).toEqual([
      expect.objectContaining({
        noteId: NOTE_ID,
        error: expect.stringContaining("kv delete failed"),
        dedupe: "claimed",
        retries: "skipped",
        postError: "Buffer API error (503): busy",
        kind: "unavailable",
        status: 503,
      }),
    ]);
  });

  test("記録の書き込みと削除が両方失敗したら、再送で投稿し直されることをログに残す", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    memory.fail("put", { keyPrefix: "claimed:" });
    memory.fail("delete");
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    await vi.runAllTimersAsync();
    await settle();
    expect(loggedLines("error", "failed to release claim")).toEqual([
      expect.objectContaining({
        dedupe: "claim-failed",
        retries: "may-repost",
      }),
    ]);
  });

  test("put が同期的に例外を投げ、削除も失敗したら、再送で投稿し直されることをログに残す", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    vi.spyOn(memory.kv, "put").mockImplementation(() => {
      throw new Error("sync put failure");
    });
    memory.fail("delete");
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    await vi.runAllTimersAsync();
    await settle();
    expect(loggedLines("error", "failed to release claim")).toEqual([
      expect.objectContaining({
        dedupe: "claim-failed",
        retries: "may-repost",
      }),
    ]);
  });

  test("書き込みが終わらないまま削除も失敗したら、再送の結果はわからないとログに残す", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    vi.spyOn(memory.kv, "put").mockReturnValue(new Promise<never>(() => {}));
    memory.fail("delete");
    const pending = send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(502);
    await settle();
    expect(loggedLines("error", "failed to release claim")).toEqual([
      expect.objectContaining({
        dedupe: "claim-failed",
        retries: "unknown",
        error: `Error: kv delete failed: ${CLAIM_KEY}`,
      }),
    ]);
  });

  test("打ち切った書き込みが待っている間に保存されたら、削除の失敗は取りこぼしとしてログに残す", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    const put = memory.kv.put.bind(memory.kv);
    // 書き込みが 1 秒の上限を過ぎ、削除の前の待ちの間に保存されることにする
    vi.spyOn(memory.kv, "put").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return put(...args);
    });
    memory.fail("delete");
    const pending = send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe(502);
    await settle();
    expect(memory.store.has(CLAIM_KEY)).toBe(true);
    expect(loggedLines("error", "failed to release claim")).toEqual([
      expect.objectContaining({
        dedupe: "claim-failed",
        retries: "skipped",
      }),
    ]);
  });

  test("記録の削除は waitUntil に登録し、応答の後も削除が終わるまで続ける", async () => {
    vi.useFakeTimers();
    const { memory, send, contexts } = setup();
    // 削除を止めて、登録した処理が削除の完了を待っているかを確かめる
    let resumeDelete = () => {};
    const remove = memory.kv.delete.bind(memory.kv);
    vi.spyOn(memory.kv, "delete").mockImplementation(async (key) => {
      await new Promise<void>((resolve) => {
        resumeDelete = resolve;
      });
      return remove(key);
    });
    const res = await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    expect(res.status).toBe(502);
    const [context] = contexts;
    expect(context?.waitUntil).toHaveBeenCalledTimes(1);
    let isSettled = false;
    void context?.settle().then(() => {
      isSettled = true;
    });
    // 最初の削除まで進めて、削除の途中で止める
    await vi.advanceTimersByTimeAsync(1100);
    expect(isSettled).toBe(false);
    expect(memory.store.has(CLAIM_KEY)).toBe(true);

    resumeDelete();
    await context?.settle();
    expect(memory.store.has(CLAIM_KEY)).toBe(false);
  });

  test.each([
    ["記録できた", 20_000, (_: MemoryKv) => {}],
    ["記録を確認できない", 4000, (m: MemoryKv) => m.fail("get")],
    [
      "記録の書き込みに失敗した",
      4000,
      (m: MemoryKv) => m.fail("put", { keyPrefix: "claimed:" }),
    ],
  ])("%s ときの投稿先のタイムアウトは %i ms", async (_, expected, breakKv) => {
    // 受信からの経過時間を差し引くため、時計を止めて値を決める
    vi.useFakeTimers();
    const { memory, send } = setup();
    breakKv(memory);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await send(mockFetch(200, bufferOk));
    // 記録がなければ再送を防げないため、Misskey の 5 秒に収める
    expect(timeout).toHaveBeenCalledWith(expected);
  });

  /** KV の操作が遅れたことにして、時計を進める */
  function slowGet(memory: MemoryKv, ms: number) {
    vi.spyOn(memory.kv, "get").mockImplementation(async () => {
      vi.setSystemTime(Date.now() + ms);
      throw new Error("kv get timed out");
    });
  }

  function slowPut(memory: MemoryKv, ms: number) {
    vi.spyOn(memory.kv, "put").mockImplementation(async () => {
      vi.setSystemTime(Date.now() + ms);
    });
  }

  test.each([
    ["重複を確認できないまま 2.5 秒たった", slowGet, 2500, 1500],
    ["記録までに 2 秒かかった", slowPut, 2000, 18_000],
    // 記録があれば再送は重複としてスキップされるので、最低限の時間は残して投稿する
    ["記録までに 25 秒かかった", slowPut, 25_000, 1000],
  ])(
    "%s ときは、受信からの経過時間を差し引いた上限にする",
    async (_, slowKv, elapsedMs, expected) => {
      vi.useFakeTimers();
      const { memory, send } = setup();
      slowKv(memory, elapsedMs);
      const timeout = vi.spyOn(AbortSignal, "timeout");
      await send(mockFetch(200, bufferOk));
      expect(timeout).toHaveBeenCalledWith(expected);
    },
  );

  /** 記録の書き込みが遅れたうえで失敗したことにする */
  function slowFailingPut(memory: MemoryKv, ms: number) {
    vi.spyOn(memory.kv, "put").mockImplementation(async () => {
      vi.setSystemTime(Date.now() + ms);
      throw new Error("kv put timed out");
    });
  }

  test.each([
    ["重複を確認できないまま 3.5 秒たった", slowGet, 3500],
    ["記録の書き込みに失敗するまで 6 秒かかった", slowFailingPut, 6000],
  ])(
    "%s ときは、Misskey の再送と二重にならないよう投稿せずに 502 を返す",
    async (_, slowKv, elapsedMs) => {
      vi.useFakeTimers();
      const { memory, send } = setup();
      slowKv(memory, elapsedMs);
      const fetcher = mockFetch(200, bufferOk);
      const res = await send(fetcher);
      expect(res.status).toBe(502);
      expect(fetcher).not.toHaveBeenCalled();
      expect(loggedLines("error", "post failed")[0]?.kind).toBe("unavailable");
    },
  );

  test.each([
    ["読み出し", "get", "unchecked"],
    ["書き込み", "put", "claim-failed"],
  ] as const)(
    "KV の%sが応答しなければ 1 秒で打ち切り、記録なしで投稿する",
    async (_, method, dedupe) => {
      vi.useFakeTimers();
      const { memory, send } = setup();
      vi.spyOn(memory.kv, method).mockReturnValue(new Promise<never>(() => {}));
      const fetcher = mockFetch(200, bufferOk);
      const pending = send(fetcher);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetcher).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(await res.json()).toEqual({ posted: "buf-1", poster: "buffer" });
      expect(loggedLines("info", "posted")[0]?.dedupe).toBe(dedupe);
    },
  );

  test("記録の書き込みが遅くても、書き込みが終わってから 1 秒以上空けて削除する", async () => {
    vi.useFakeTimers();
    const { memory, send } = setup();
    const put = memory.kv.put.bind(memory.kv);
    // 書き込みに 2 秒かかったことにする
    vi.spyOn(memory.kv, "put").mockImplementation(async (...args) => {
      vi.setSystemTime(Date.now() + 2000);
      return put(...args);
    });
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    await send(mockFetch(503, { errors: [{ message: "busy" }] }));
    await vi.advanceTimersByTimeAsync(1099);
    expect(deleteSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  test("記録から 1 秒以上たっていれば、待たずに削除する", async () => {
    vi.useFakeTimers();
    const { memory, send } = setup();
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    const busy = mockFetch(503, { errors: [{ message: "busy" }] });
    // 投稿先が 2 秒かかって 503 を返したことにする
    const slow = vi.fn<typeof fetch>(async (...args) => {
      vi.setSystemTime(Date.now() + 2000);
      return busy(...args);
    });
    await send(slow);
    await vi.advanceTimersByTimeAsync(0);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  test("投稿先のエラーのメッセージが長いときは、応答とログで切り詰める", async () => {
    const { send } = setup();
    const res = await send(
      mockFetch(400, { errors: [{ message: "x".repeat(2000) }] }),
    );
    const { error } = (await res.json()) as { error: string };
    expect(error).toHaveLength(501);
    expect(error.endsWith("…")).toBe(true);
    expect(loggedLines("error", "post failed")[0]?.error).toBe(error);
  });

  test("KV がないときの投稿先のタイムアウトは 4 秒", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await handleRequest(
      request(makePayload()),
      bufferEnv,
      ctx(),
      mockFetch(200, bufferOk),
    );
    expect(timeout).toHaveBeenCalledWith(4000);
  });

  test("失敗のログを出してから、記録の削除を始める", async () => {
    vi.useFakeTimers();
    const { memory, send, settle } = setup();
    const order: string[] = [];
    vi.mocked(console.error).mockImplementation((line) => {
      order.push(JSON.parse(String(line)).msg);
    });
    const remove = memory.kv.delete.bind(memory.kv);
    vi.spyOn(memory.kv, "delete").mockImplementation(async (key) => {
      order.push("kv.delete");
      return remove(key);
    });
    // 記録から 1 秒以上たっていて削除の前に待たない状況でも、ログが先に出ることを確かめる
    const busy = mockFetch(503, { errors: [{ message: "busy" }] });
    await send(
      vi.fn<typeof fetch>(async (...args) => {
        vi.setSystemTime(Date.now() + 2000);
        return busy(...args);
      }),
    );
    await settle();
    expect(order).toEqual(["post failed", "kv.delete"]);
  });

  test.each([
    ["成功", () => mockFetch(200, bufferOk)],
    ["rejected", () => mockFetch(400, { errors: [{ message: "bad" }] })],
    ["unknown", () => mockFetch(504, { errors: [{ message: "timeout" }] })],
  ])("%s のときは記録の削除を試みない", async (_, makeFetcher) => {
    const { memory, send, settle, contexts } = setup();
    const deleteSpy = vi.spyOn(memory.kv, "delete");
    await send(makeFetcher());
    await settle();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(contexts[0]?.waitUntil).not.toHaveBeenCalled();
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
      ctx(),
      fetcher,
    );
    expect(await res.json()).toEqual({ skipped: "empty" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(memory.store.size).toBe(0);
  });

  function loggedLines(method: "info" | "warn" | "error", msg: string) {
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
    await handleRequest(
      request(makePayload()),
      env,
      ctx(),
      mockFetch(200, bufferOk),
    );
    expect(loggedLines("info", "posted")[0]?.dedupe).toBe(expected);
  });

  test("投稿に失敗したときのログにも重複の防止の状態を残す", async () => {
    const { memory, send } = setup();
    memory.fail("get");
    await send(mockFetch(400, { errors: [{ message: "bad request" }] }));
    expect(loggedLines("error", "post failed")[0]?.dedupe).toBe("unchecked");
  });

  test.each([
    [
      "記録の日時",
      JSON.stringify({ claimedAt: "2026-10-05T09:54:20.458Z" }),
      "2026-10-05T09:54:20.458Z",
    ],
    ["{}", "{}", undefined],
    ["不正な JSON", "not json", undefined],
    ["JSON の null", "null", undefined],
    ["数値の claimedAt", JSON.stringify({ claimedAt: 1 }), undefined],
  ])(
    "記録の値が %s でも重複として投稿せず、読めた日時だけをログに残す",
    async (_, value, claimedAt) => {
      const { send } = setup({ [CLAIM_KEY]: value });
      const fetcher = mockFetch(200, bufferOk);
      const res = await send(fetcher);
      expect(await res.json()).toEqual({ skipped: "duplicate" });
      expect(fetcher).not.toHaveBeenCalled();
      const [line] = loggedLines("info", "skipped");
      expect(line?.reason).toBe("duplicate");
      expect(line?.claimedAt).toBe(claimedAt);
    },
  );

  test("投稿に失敗したときのログに、投稿先の応答を残す", async () => {
    const { send } = setup();
    const body = { errors: [{ message: "bad request" }] };
    await send(mockFetch(400, body));
    expect(loggedLines("error", "post failed")[0]?.detail).toEqual(body);
  });

  test("投稿先の応答が大きいときは、ログでは切り詰める", async () => {
    const { send } = setup();
    const body = { errors: [{ message: "x".repeat(2000) }] };
    await send(mockFetch(400, body));
    const detail = loggedLines("error", "post failed")[0]?.detail;
    expect(detail).toBe(`${JSON.stringify(body).slice(0, 1000)}…`);
  });

  test("JSON にできない detail でも、エラー処理を止めずにログに残す", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    vi.spyOn(BufferPoster.prototype, "post").mockRejectedValue(
      new PosterError("boom", "unavailable", 503, circular),
    );
    // KV なしにして、応答の後に削除の処理を残さない
    const res = await handleRequest(
      request(makePayload()),
      bufferEnv,
      ctx(),
      mockFetch(200, bufferOk),
    );
    expect(res.status).toBe(502);
    expect(loggedLines("error", "post failed")[0]?.detail).toBe(
      "[object Object]",
    );
  });

  test.each([
    [
      "Error を継承しない例外の stack",
      { stack: "DOMException: aborted" },
      "DOMException: aborted",
    ],
    ["文字列でない stack", { stack: 1 }, undefined],
  ])("%s は、文字列のときだけログに残す", async (_, cause, expected) => {
    vi.spyOn(BufferPoster.prototype, "post").mockRejectedValue(
      new PosterError("boom", "unknown", undefined, undefined, cause),
    );
    await handleRequest(
      request(makePayload()),
      bufferEnv,
      ctx(),
      mockFetch(200, bufferOk),
    );
    expect(loggedLines("error", "post failed")[0]?.stack).toBe(expected);
  });

  test("投稿の外の想定外の例外は 502 で、ログにスタックトレースを残す", async () => {
    const original = new TypeError("binding broken");
    // 想定外の例外を起こすため、KV のバインディングの読み出しで例外を投げる
    const env = { ...bufferEnv } as Env;
    Object.defineProperty(env, "POSTED_NOTES", {
      get() {
        throw original;
      },
    });
    const fetcher = mockFetch(200, bufferOk);
    const res = await handleRequest(
      request(makePayload()),
      env,
      ctx(),
      fetcher,
    );
    expect(res.status).toBe(502);
    expect(fetcher).not.toHaveBeenCalled();
    const [line] = loggedLines("error", "unexpected error");
    expect(line?.stack).toBe(original.stack);
  });

  test("投稿中の想定外の例外は、ログにスタックトレースを残す", async () => {
    const { send } = setup();
    const original = new TypeError("unexpected shape");
    vi.spyOn(BufferPoster.prototype, "post").mockRejectedValue(original);
    await send(mockFetch(200, bufferOk));
    const [line] = loggedLines("error", "post failed");
    // 包んだ PosterError ではなく、元の例外のスタック
    expect(line?.stack).toBe(original.stack);
  });

  test("シークレット不足は 500 で、KV に何も記録しない", async () => {
    const memory = createMemoryKv();
    const res = await handleRequest(
      request(makePayload()),
      {
        MISSKEY_HOOK_SECRET: SECRET,
        POSTED_NOTES: memory.kv,
      },
      ctx(),
    );
    expect(res.status).toBe(500);
    expect(memory.store.size).toBe(0);
  });
});

describe("Worker の fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("切断で打ち切られないよう、処理が終わる前に処理全体を waitUntil に登録する", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const memory = createMemoryKv();
    // 記録の書き込みで処理を止め、その間に登録済みかを確かめる
    let resumePut = () => {};
    const put = memory.kv.put.bind(memory.kv);
    const putSpy = vi
      .spyOn(memory.kv, "put")
      .mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          resumePut = resolve;
        });
        return put(...args);
      });
    vi.stubGlobal("fetch", mockFetch(200, bufferOk));
    const context = createContext();

    const response = worker.fetch(
      request(makePayload()) as Parameters<typeof worker.fetch>[0],
      { ...bufferEnv, POSTED_NOTES: memory.kv },
      context.ctx as ExecutionContext,
    );
    await vi.waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(context.waitUntil).toHaveBeenCalledTimes(1);
    let isSettled = false;
    void context.settle().then(() => {
      isSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isSettled).toBe(false);

    resumePut();
    const res = await response;
    expect(await res.json()).toEqual({ posted: "buf-1", poster: "buffer" });
    await expect(context.waitUntil.mock.calls[0]?.[0]).resolves.toBe(res);
  });

  test("処理が例外で終わっても、waitUntil に登録した Promise は reject しない", async () => {
    const context = createContext();
    // ヘッダーの読み出しで例外を投げ、try の外の処理を失敗させる
    const broken = {
      method: "POST",
      headers: {
        get() {
          throw new TypeError("headers unavailable");
        },
      },
    } as unknown as Parameters<typeof worker.fetch>[0];
    const response = worker.fetch(
      broken,
      bufferEnv,
      context.ctx as ExecutionContext,
    );
    await expect(response).rejects.toThrow(TypeError);
    await expect(context.waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });

  test("記録の削除も、受け取った ctx の waitUntil に登録する", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const memory = createMemoryKv();
    vi.stubGlobal("fetch", mockFetch(503, { errors: [{ message: "busy" }] }));
    const context = createContext();

    const res = await worker.fetch(
      request(makePayload()) as Parameters<typeof worker.fetch>[0],
      { ...bufferEnv, POSTED_NOTES: memory.kv },
      context.ctx as ExecutionContext,
    );
    expect(res.status).toBe(502);
    // 処理全体の登録は応答で終わるため、応答の後も続く削除は別に登録する必要がある
    expect(context.waitUntil).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();
    await context.settle();
    expect(memory.store.has(`claimed:${makeNote().id}`)).toBe(false);
  });
});
