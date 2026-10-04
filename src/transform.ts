import type { Config } from "./config";
import type { MisskeyNote } from "./misskey";
import {
  MAX_WEIGHTED_LENGTH,
  truncateWeighted,
  URL_WEIGHT,
  weightedLength,
} from "./weighted-length";

export const MAX_IMAGES = 4;

export interface OutgoingPost {
  text: string;
  imageUrls: string[];
  truncated: boolean;
}

export type FilterResult = { ok: true } | { ok: false; reason: string };

/** 転送対象のノートかどうかを判定する */
export function shouldForward(note: MisskeyNote, config: Config): FilterResult {
  if (!config.visibilities.has(note.visibility)) {
    return { ok: false, reason: `visibility:${note.visibility}` };
  }
  if (note.localOnly) return { ok: false, reason: "local-only" };
  if (note.replyId && !config.includeReplies) {
    return { ok: false, reason: "reply" };
  }
  const hasText = (note.text ?? "").trim().length > 0;
  const hasFiles = (note.files ?? []).length > 0;
  if (note.renoteId && !hasText && !hasFiles) {
    return { ok: false, reason: "pure-renote" };
  }
  if (note.cw != null && config.cwMode === "skip") {
    return { ok: false, reason: "cw" };
  }
  const excluded = (note.tags ?? []).find((t) =>
    config.excludeTags.has(t.toLowerCase()),
  );
  if (excluded) return { ok: false, reason: `exclude-tag:${excluded}` };
  return { ok: true };
}

/** `$[fn ...]` 構文や MFM 専用タグを取り除き、中身のテキストだけを残す */
export function stripMfm(text: string): string {
  let out = text;
  // 内側から順に展開する（中身に [ ] を含まない最小の $[...] を繰り返し置換）
  for (let i = 0; i < 32; i++) {
    const next = out.replace(/\$\[[^\s[\]]+ ?([^[\]]*)\]/g, "$1");
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/<\/?(?:center|small|plain|i|b|s)>/g, "")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/~~(.+?)~~/gs, "$1");
}

/** `:blobcat:` のようなカスタム絵文字のショートコードを取り除く */
export function stripCustomEmoji(text: string): string {
  return text
    .replace(/:[a-z0-9_+-]*[a-z_][a-z0-9_+-]*:/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n");
}

/**
 * `@user` / `@user@host` が X 上の別ユーザーへのメンションにならないよう、
 * `@` の直後にゼロ幅スペースを挟む。
 */
export function defuseMentions(text: string): string {
  return text.replace(/(^|[^\w@])@(?=[A-Za-z0-9_])/g, "$1@​");
}

export function buildPost(
  note: MisskeyNote,
  config: Config,
  link?: string,
): OutgoingPost {
  let body = note.text ?? "";
  if (note.cw != null && config.cwMode === "include") {
    body = body ? `${note.cw}\n\n${body}` : note.cw;
  }
  body = stripMfm(body);
  if (config.stripCustomEmoji) body = stripCustomEmoji(body);
  body = defuseMentions(body).trim();

  // リンクを付ける場合は「改行 1 文字 + URL」分を本文の上限から差し引く
  const withLink = (url: string) => {
    const r = truncateWeighted(body, MAX_WEIGHTED_LENGTH - (URL_WEIGHT + 1));
    return {
      text: r.text ? `${r.text}\n${url}` : url,
      truncated: r.truncated,
    };
  };

  let text: string;
  let truncated = false;

  if (link !== undefined && config.appendLink === "always") {
    ({ text, truncated } = withLink(link));
  } else if (weightedLength(body) <= MAX_WEIGHTED_LENGTH) {
    text = body;
  } else if (link !== undefined && config.appendLink === "truncated") {
    ({ text, truncated } = withLink(link));
  } else {
    ({ text, truncated } = truncateWeighted(body));
  }

  const imageUrls = (note.files ?? [])
    .filter((f) => f.type.startsWith("image/"))
    .filter((f) => config.attachSensitive || !f.isSensitive)
    .slice(0, MAX_IMAGES)
    .map((f) => f.url);

  return { text, imageUrls, truncated };
}
