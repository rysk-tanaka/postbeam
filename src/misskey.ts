/** Misskey の webhook で送られてくるドライブファイル（必要な項目のみ） */
export interface MisskeyFile {
  id: string;
  type: string;
  url: string;
  isSensitive: boolean;
  comment?: string | null;
}

/** Misskey のノート（必要な項目のみ） */
export interface MisskeyNote {
  id: string;
  text: string | null;
  cw?: string | null;
  visibility: "public" | "home" | "followers" | "specified" | string;
  localOnly?: boolean;
  replyId?: string | null;
  renoteId?: string | null;
  files?: MisskeyFile[];
  tags?: string[];
  url?: string | null;
  uri?: string | null;
}

/**
 * Misskey の user webhook の payload。
 * https://misskey-hub.net/ja/docs/for-users/features/webhook/
 */
export interface MisskeyWebhookPayload {
  server?: string;
  hookId: string;
  userId: string;
  eventId: string;
  createdAt: number;
  type: string;
  body: { note?: MisskeyNote };
}

export function isWebhookPayload(
  value: unknown,
): value is MisskeyWebhookPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string") return false;
  if (typeof v.body !== "object" || v.body === null) return false;
  // id のないノートは扱えない。例外で 500 になると、Misskey が再送し続ける
  const note = (v.body as Record<string, unknown>).note;
  if (note === undefined || note === null) return true;
  const isObject = typeof note === "object";
  return isObject && typeof (note as { id?: unknown }).id === "string";
}

export function noteUrl(
  note: MisskeyNote,
  server?: string,
): string | undefined {
  if (server) return `${server.replace(/\/+$/, "")}/notes/${note.id}`;
  return note.url ?? undefined;
}
