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
