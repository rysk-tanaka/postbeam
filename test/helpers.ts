import { vi } from "vitest";
import { type Config, loadConfig } from "../src/config";
import type { MisskeyNote, MisskeyWebhookPayload } from "../src/misskey";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ MISSKEY_HOOK_SECRET: "s" }), ...overrides };
}

export function makeNote(overrides: Partial<MisskeyNote> = {}): MisskeyNote {
  return {
    id: "a1b2c3",
    text: "こんにちは",
    cw: null,
    visibility: "public",
    localOnly: false,
    replyId: null,
    renoteId: null,
    files: [],
    tags: [],
    ...overrides,
  };
}

export function makePayload(
  note: MisskeyNote | undefined = makeNote(),
  overrides: Partial<MisskeyWebhookPayload> = {},
): MisskeyWebhookPayload {
  return {
    server: "https://misskey.example",
    hookId: "hook1",
    userId: "user1",
    eventId: "event1",
    createdAt: 1_791_000_000_000,
    type: "note",
    body: { note },
    ...overrides,
  };
}

type KvMethod = "get" | "put" | "delete";

interface KvFailure {
  method: KvMethod;
  keyPrefix: string;
  remaining: number;
}

export interface MemoryKv {
  kv: KVNamespace;
  store: Map<string, string>;
  ttls: Map<string, number | undefined>;
  /** KV の障害や書き込み制限を模擬するため、条件に合う呼び出しを times 回だけ失敗させる */
  fail(
    method: KvMethod,
    options?: { keyPrefix?: string; times?: number },
  ): void;
}

/** Map で中身を持つ KV。テストで使うメソッドだけを実装する */
export function createMemoryKv(initial: Record<string, string> = {}): MemoryKv {
  const store = new Map(Object.entries(initial));
  const ttls = new Map<string, number | undefined>();
  const failures: KvFailure[] = [];

  const maybeFail = (method: KvMethod, key: string) => {
    const failure = failures.find((f) => {
      const isSameMethod = f.method === method;
      const hasRemaining = f.remaining > 0;
      const matchesKey = key.startsWith(f.keyPrefix);
      return isSameMethod && hasRemaining && matchesKey;
    });
    if (!failure) return;
    failure.remaining--;
    throw new Error(`kv ${method} failed: ${key}`);
  };

  const kv = {
    async get(key: string, type?: "text" | "json") {
      maybeFail("get", key);
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) {
      maybeFail("put", key);
      store.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    async delete(key: string) {
      maybeFail("delete", key);
      store.delete(key);
    },
  };

  return {
    kv: kv as unknown as KVNamespace,
    store,
    ttls,
    fail(method, { keyPrefix = "", times = Number.POSITIVE_INFINITY } = {}) {
      failures.push({ method, keyPrefix, remaining: times });
    },
  };
}

export interface TestContext {
  ctx: Pick<ExecutionContext, "waitUntil">;
  waitUntil: ReturnType<typeof vi.fn<(promise: Promise<unknown>) => void>>;
  /** waitUntil に渡された処理がすべて終わるのを待つ */
  settle(): Promise<void>;
}

/** waitUntil に渡された Promise を集める ExecutionContext */
export function createContext(): TestContext {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });
  return {
    ctx: { waitUntil },
    waitUntil,
    async settle() {
      // 待っている間に登録された処理も待つ
      let settled = 0;
      while (settled < pending.length) {
        const count = pending.length;
        await Promise.allSettled(pending);
        settled = count;
      }
    },
  };
}
