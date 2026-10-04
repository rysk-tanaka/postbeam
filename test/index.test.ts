import { afterEach, describe, expect, test, vi } from "vitest";
import type { Env } from "../src/config";
import { handleRequest } from "../src/index";
import { BUFFER_API_URL } from "../src/posters/buffer";
import { X_CREATE_POST_URL } from "../src/posters/x";
import { makeNote, makePayload } from "./helpers";

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
    expect(new Headers(init?.headers).get("Authorization")).toMatch(
      /^OAuth .*oauth_consumer_key="ck".*oauth_signature="/,
    );
    expect(JSON.parse(String(init?.body))).toEqual({ text: "こんにちは" });
  });
});
