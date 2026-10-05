import type { Config } from "./config";
import type { MisskeyNote } from "./misskey";
import {
  blocksFollowingUrl,
  continuesUrl,
  findUrls,
  isTrimmedFromUrlEnd,
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

const MFM_FN_PATTERN = /\$\[[^\s[\]]+ ?([^[\]]*)\]/g;
const MFM_LINK_PATTERN =
  /\??\[([^[\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/giu;
// 変換した URL の前後に置く目印。前後の文字は MFM の記号を取り除くまで確定しないため、
// 最後に空白にするか消すかを決める。本文に現れない非文字（U+FDD0 / U+FDD1）を使う
const LINK_START = "\uFDD0";
const LINK_END = "\uFDD1";
const LINK_START_PATTERN = new RegExp(`(.?)${LINK_START}`, "gsu");
// 目印の直後の文字と、その次の文字（後者は消費しない）
const LINK_END_PATTERN = new RegExp(`${LINK_END}(.?)(?=(.?))`, "gsu");

/** `[label](url)` / `?[label](url)` を `label url` にする */
function convertMfmLinks(text: string): string {
  return text.replace(MFM_LINK_PATTERN, (_, label: string, url: string) => {
    const name = label.trim();
    // ラベルを省くと URL が直前の文字に続くので、前にも目印を置く
    const head = name === "" || name === url ? LINK_START : `${name} `;
    return `${head}${url}${LINK_END}`;
  });
}

/**
 * リンクの変換で置いた目印を、必要なら空白に、不要なら消す。
 * 英数字の直後の URL は X がリンクにせず、URL に続く文字は URL に取り込まれるため、
 * そのときだけ空白で区切る。対応する ( のない ) と、文末の句読点は URL に取り込まれないので区切らない。
 */
function resolveLinkMarkers(text: string): string {
  return text
    .replace(LINK_END_PATTERN, (_, next: string, after: string) => {
      const isDroppedFromUrl =
        isTrimmedFromUrlEnd(next) && !continuesUrl(after);
      const needsSeparator =
        next !== "" && next !== ")" && !isDroppedFromUrl && continuesUrl(next);
      return needsSeparator ? ` ${next}` : next;
    })
    .replace(LINK_START_PATTERN, (_, prev: string) => {
      const needsSeparator = prev !== "" && blocksFollowingUrl(prev);
      return needsSeparator ? `${prev} ` : prev;
    });
}

/** `$[fn ...]` 構文やリンク記法、MFM 専用タグを取り除き、中身のテキストだけを残す */
export function stripMfm(text: string): string {
  let out = text;
  // 内側から順に展開する（中身に [ ] を含まない最小の $[...] を繰り返し置換）。
  // リンクのラベルに $[...] があったり、$[...] の中にリンクがあったりするため、
  // リンクの変換と交互に繰り返す
  for (let i = 0; i < 32; i++) {
    const next = convertMfmLinks(out).replace(MFM_FN_PATTERN, "$1");
    if (next === out) break;
    out = next;
  }
  return resolveLinkMarkers(
    out
      .replace(/<\/?(?:center|small|plain|i|b|s)>/g, "")
      .replace(/\*\*(.+?)\*\*/gs, "$1")
      .replace(/~~(.+?)~~/gs, "$1"),
  );
}

/**
 * URL の中の `@` や `:` を書き換えないよう、URL と重なるマッチを飛ばして置換する。
 * 区間に切り分けずに本文全体へかけるのは、前後の文字を見る先読み・後読みや
 * 行頭・行末の判定が、URL との境界でも正しく働くようにするため。
 */
function replaceOutsideUrls(
  text: string,
  pattern: RegExp,
  replacer: (match: string, groups: string[], offset: number) => string,
): string {
  const urls = findUrls(text);
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    // 名前付きグループのない正規表現では、末尾の 2 つが offset と元の文字列
    const offset = rest[rest.length - 2] as number;
    const end = offset + match.length;
    const overlapsUrl = urls.some((u) => offset < u.end && end > u.start);
    if (overlapsUrl) return match;
    return replacer(match, rest.slice(0, -2) as string[], offset);
  });
}

// `12:30:45` を除くため、英字か _ を 1 つ以上含む名前だけを対象にする。
// `[a-z0-9_+-]*[a-z_][a-z0-9_+-]*` と書くとバックトラックが二乗になるため先読みで表す
// Misskey（mfm-js）は閉じる : の直後が英数字なら絵文字として扱わないが、ここでは
// 判定しない。MFM の記号（`**` や `]`）を取り除いた後の本文では、絵文字の直後に
// 英数字が来ることがあり、取り除くべき絵文字が残ってしまうため
const CUSTOM_EMOJI = ":(?=[0-9+-]*[a-z_])[a-z0-9_+-]+:";
// 絵文字の連なり（間の空白を含む）を、前後の空白ごとまとめてマッチさせる。
// 空白の途中から何度も試さないよう、空白の連続の先頭からだけマッチさせる
const CUSTOM_EMOJI_RUN_PATTERN = new RegExp(
  `(?<![ \\t])([ \\t]*)${CUSTOM_EMOJI}(?:[ \\t]*${CUSTOM_EMOJI})*([ \\t]*)`,
  "gi",
);

/**
 * `:blobcat:` のようなカスタム絵文字のショートコードを取り除く。
 * 取り除いた箇所の前後の空白は、本文が不自然に空かないよう詰める。
 */
export function stripCustomEmoji(text: string): string {
  return replaceOutsideUrls(
    text,
    CUSTOM_EMOJI_RUN_PATTERN,
    (match, [before = "", after = ""], start) => {
      const end = start + match.length;
      const isLineStart = start === 0 || text[start - 1] === "\n";
      const isLineEnd =
        end === text.length || text[end] === "\n" || text[end] === "\r";
      if (isLineEnd) return "";
      // 行頭の空白はインデントとして残す
      if (isLineStart) return before;
      const hasSpaceAround = before !== "" || after !== "";
      if (hasSpaceAround) return " ";
      // 英数字と URL の間の絵文字を詰めると、X が URL とみなさなくなるので区切る
      const prev = text[start - 1] ?? "";
      const isBeforeUrl = /^https?:\/\//i.test(text.slice(end, end + 8));
      const needsSeparator = isBeforeUrl && blocksFollowingUrl(prev);
      return needsSeparator ? " " : "";
    },
  );
}

// X は全角の ＠ もメンションの記号として扱う
const MENTION_PATTERN = /(^|[^\w@＠])([@＠])(?=[A-Za-z0-9_])/g;
// X は RT の直後の @ もメンションとして扱う（`RT@user` / `RT:@user`）
const RT_MENTION_PATTERN =
  /(^|[^A-Za-z0-9_+~.-])(rt:?)([@＠])(?=[A-Za-z0-9_])/gi;

/**
 * `@user` / `@user@host` が X 上の別ユーザーへのメンションにならないよう、
 * `@` の直後にゼロ幅スペースを挟む。
 */
export function defuseMentions(text: string): string {
  const defused = replaceOutsideUrls(
    text,
    MENTION_PATTERN,
    (_, [prefix = "", mark = ""]) => `${prefix}${mark}​`,
  );
  return replaceOutsideUrls(
    defused,
    RT_MENTION_PATTERN,
    (_, [prefix = "", rt = "", mark = ""]) => `${prefix}${rt}${mark}​`,
  );
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
