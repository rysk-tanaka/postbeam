import type { Config } from "./config";
import type { MisskeyNote } from "./misskey";
import {
  changesReadingWhenJoined,
  findProtocolChunks,
  findUrls,
  MAX_WEIGHTED_LENGTH,
  SPACE_PATTERN,
  trimJoinContext,
  truncateWeighted,
  URL_WEIGHT,
  type UrlMatch,
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

// 関数名には、リンクの変換で置く目印（U+FDD0〜U+FDD2）を含めない。含めると、崩れた MFM
// （`$[tada[ ](url)]`）で目印と URL を関数名として読み、リンクが丸ごと消える
const MFM_FN_PATTERN = /\$\[[^\s[\]\uFDD0-\uFDD2]+ ?([^[\]]*)\]/g;
const MFM_LINK_PATTERN =
  /\??\[([^[\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/giu;
// 変換した URL の前後に置く目印。前後の文字は MFM の記号を取り除くまで確定しないため、
// 最後に空白にするか消すかを決める。本文に現れない非文字（U+FDD0 / U+FDD1）を使う
const LINK_START = "\uFDD0";
const LINK_END = "\uFDD1";
// 取り除いたカスタム絵文字の跡に置く目印（U+FDD2）。詰めるか区切るかは、同じ語の中の
// ほかの絵文字の跡と合わせて確かめてから決める（stripCustomEmoji を参照）
const EMOJI_GAP = "\uFDD2";
const EMOJI_GAP_PATTERN = new RegExp(EMOJI_GAP, "g");
const LINK_START_PATTERN = new RegExp(`(.?)${LINK_START}`, "gsu");
// 目印と、その直前の変換した URL。URL は LINK_START の直後に置かれる（convertMfmLinks を参照）
const LINK_END_PATTERN = new RegExp(
  `(?<=^|[\\s${LINK_START}])(https?://[^\\s${LINK_START}${LINK_END}]*)${LINK_END}`,
  "giu",
);
// LINK_END_PATTERN に当たらず判定できなかった目印。崩れた MFM で、URL の途中から $[...] の
// 展開が始まると（リンク先に `]` を含む `a$[tada[ ](https://a.com/]x)y`）、URL の手前の目印がなくなる
const LINK_END_MARK_PATTERN = new RegExp(LINK_END, "g");
const MARKER_PATTERN = new RegExp(
  `[${LINK_START}${LINK_END}${EMOJI_GAP}]`,
  "gu",
);
// ハッシュタグとキャッシュタグの始まりの記号。
// 前の語に詰めると、X がタグの始まりとみなさなくなる。X は文字（日本語を含む英字・数字）や
// _・&、URL の直後の # を、空白の直後でない $ を始まりとみなさない。読み方の確認（findUrls と
// 同じ走査）では見つからないので、文字で判定して区切る。絵文字の跡は直前が : なので、
// もともと $ はキャッシュタグにならず、# だけを見る
const HASHTAG_MARKS = "#＃";
const TAG_MARKS = `${HASHTAG_MARKS}$`;
const TAG_MARK_PATTERN = new RegExp(`^[${TAG_MARKS}]`);
const HASHTAG_MARK_PATTERN = new RegExp(`^[${HASHTAG_MARKS}]`);
// ハッシュタグやキャッシュタグに続けて書ける文字。twitter-text の hashtagSpecialChars
// （`・`・`〜`・ZWJ など）と、X がハッシュタグの文字とみなす私用領域の文字を含め、
// . はキャッシュタグ（`$BRK.A`）のために、surrogate は文字の片割れとして含める。
// 後ろの語を詰めるとタグが別のタグに変わり、ハッシュタグの後ろに `://` が続くと X は
// ハッシュタグとみなさなくなる。ZWJ は文字クラスに入れると結合した並びと紛らわしいので分ける
const TAG_CHAR_PATTERN =
  /^(?:[\p{L}\p{M}\p{N}_.\u200C\uA67E\u05BE\u05F3\u05F4\uFF5E\u301C\u309B\u309C\u30A0\u30FB\u3003\u0F0B\u0F0C\u00B7\uF870-\uF87F\uF882\uF884-\uF89F\uF8B8\uF8C1-\uF8D6\uD800-\uDFFF]|\u200D)$/u;
// 区切るかを決めるために、前後で確かめる本文の長さの上限。
// 空白のない本文が長く続いても、リンクごとに本文の終わりまで読まないようにする。
// X は URL にしないかたまりを長さによらず消費するので、これより長い本文は確かめずに区切る
const LINK_CONTEXT_LENGTH = 4100;
// stripMfm と stripCustomEmoji の 1 回の呼び出しで、区切るかを確かめる走査の重さの上限。
// 前後の語から切り出した部分の文字数に READING_SCAN_COST を掛けて数える（約 5,000 文字ぶん）。
// 空白のない長い本文に、. を含む語と絵文字やリンクが並ぶと、そのたびに前後の語を走査して
// 長さの二乗の時間がかかる。Workers の CPU 時間の上限を超えないよう、使い切ったら確かめずに区切る
const READING_CHECK_BUDGET = 40_000;
// 1 回の確認で、切り出した部分を何度か走査し、メンションを無害化した後でも試すので、
// 文字数の 8 倍として数える
const READING_SCAN_COST = 8;

/** `[label](url)` / `?[label](url)` を `label url` にする */
function convertMfmLinks(text: string): string {
  return text.replace(MFM_LINK_PATTERN, (_, label: string, url: string) => {
    const name = label.trim();
    // ラベルを省くと URL が直前の文字に続くので、前にも目印を置く。ラベルがあっても、
    // 崩れた MFM（`abc$[tada[公式](url)]`）では $[...] の展開がラベルと空白を取り込み、
    // URL が直前の文字に続くので、空白の後ろにも目印を置く
    const head = name === "" || name === url ? "" : `${name} `;
    return `${head}${LINK_START}${url}${LINK_END}`;
  });
}

/**
 * 本文の語（X が空白とみなす文字で区切ったもの）を、位置から引く。BOM は直後の URL を X が
 * URL にしない文字なので、語に含める。まだ残っている目印は、後で消えるか空白になるかが
 * 決まっていないので、両方の場合の語を返す。語が上限より長ければ undefined
 */
interface WordIndex {
  /** index の手前の空白の後ろから index までの語 */
  before(index: number): WordVariants | undefined;
  /** index から次の空白までの語 */
  after(index: number): WordVariants | undefined;
  /** before(beforeEnd) と after(afterStart) のどちらかが . を含むか */
  hasDotAround(beforeEnd: number, afterStart: number): boolean;
  /**
   * index の手前が、ハッシュタグかキャッシュタグの途中か（TAG_CHAR_PATTERN を参照）。
   * # の直前の文字や、キャッシュタグの長さは見ないので、X のタグの規則より広く、区切る側に倒す
   */
  endsInTag(index: number): boolean;
}

/**
 * 語の範囲、. の数、タグの途中かを前もって求めておく。つなぎ目ごとに空白を探し直さないようにし、
 * hasDotAround を使う側（stripCustomEmoji）では、. のない語を切り出さずに済ませる
 */
function indexWords(text: string): WordIndex {
  const length = text.length;
  const wordStarts = new Int32Array(length + 1);
  const wordEnds = new Int32Array(length + 1).fill(length);
  const dotCounts = new Int32Array(length + 1);
  const inTag = new Uint8Array(length + 1);
  for (let i = 0; i < length; i++) {
    const char = text[i] ?? "";
    const isSpace = SPACE_PATTERN.test(char);
    wordStarts[i + 1] = isSpace ? i + 1 : (wordStarts[i] ?? 0);
    dotCounts[i + 1] = (dotCounts[i] ?? 0) + (char === "." ? 1 : 0);
    const continuesTag = inTag[i] === 1 && TAG_CHAR_PATTERN.test(char);
    inTag[i + 1] = TAG_MARK_PATTERN.test(char) || continuesTag ? 1 : 0;
  }
  for (let i = length - 1; i >= 0; i--) {
    const isSpace = SPACE_PATTERN.test(text[i] ?? "");
    wordEnds[i] = isSpace ? i : (wordEnds[i + 1] ?? length);
  }
  const dotsBetween = (start: number, end: number) =>
    (dotCounts[end] ?? 0) - (dotCounts[start] ?? 0);
  // 長すぎる語は、切り出す前に確かめない。目印ごとに長い語を切り出すと、長さの二乗の時間がかかる
  const isTooLong = (start: number, end: number) =>
    end - start > LINK_CONTEXT_LENGTH;
  return {
    before: (index) => {
      const start = wordStarts[index] ?? 0;
      if (isTooLong(start, index)) return undefined;
      const word = text.slice(start, index);
      return wordVariants(word, word.split(MARKER_PATTERN).at(-1) ?? "");
    },
    after: (index) => {
      const end = wordEnds[index] ?? length;
      if (isTooLong(index, end)) return undefined;
      const word = text.slice(index, end);
      return wordVariants(word, word.split(MARKER_PATTERN, 1)[0] ?? "");
    },
    hasDotAround: (beforeEnd, afterStart) =>
      dotsBetween(wordStarts[beforeEnd] ?? 0, beforeEnd) > 0 ||
      dotsBetween(afterStart, wordEnds[afterStart] ?? length) > 0,
    endsInTag: (index) => inTag[index] === 1,
  };
}

/**
 * 最初に引いたときに indexWords を作る。リンクのないノートが大半なので、本文全体の語の位置を
 * 毎回求めないようにする
 */
function lazyWords(text: string): WordIndex {
  let index: WordIndex | undefined;
  const get = () => {
    index ??= indexWords(text);
    return index;
  };
  return {
    before: (i) => get().before(i),
    after: (i) => get().after(i),
    hasDotAround: (beforeEnd, afterStart) =>
      get().hasDotAround(beforeEnd, afterStart),
    endsInTag: (index) => get().endsInTag(index),
  };
}

/**
 * 確かめる語の候補。空の配列を返すと、どの組み合わせでも変わらないとみなされて区切らない側に
 * 倒れるので、型で 1 つ以上にする
 */
type WordVariants = readonly [string, ...string[]];

/** 目印が消える場合の語と、目印が空白になる場合の語（cut）。同じなら 1 つ */
function wordVariants(word: string, cut: string): WordVariants {
  const joined = word.replace(MARKER_PATTERN, "");
  return joined === cut ? [joined] : [joined, cut];
}

/**
 * 前後の語を詰めて続けると X の読み方が変わるかを返す関数を作る。前後の語は、確かめるときだけ
 * 切り出すよう関数で渡し、長すぎて確かめない側は undefined を返す。語が複数あれば（wordVariants）、
 * どの組み合わせかで変われば変わるとみなす。
 * 読む文字数の上限（READING_CHECK_BUDGET）は、作った関数ごとに数える。
 * URL と認める範囲が変わる（URL でなくなる場合を含む）か、走査がつなぎ目をまたげば変わる。
 * 消費だけが伸びる場合（t.co の URL や、findUrls が URL にしないリンク先）も、
 * 続けて書いた URL が読み飛ばされたり、X がリンク先を変えたりするので区切る
 */
function createReadingCheck(): (
  getBefore: () => WordVariants | undefined,
  getAfter: () => WordVariants | undefined,
) => boolean {
  let budget = READING_CHECK_BUDGET;
  const spend = (cost: number) => {
    budget -= cost;
    return budget >= 0;
  };
  const changes = (before: string, after: string): boolean => {
    // 空の語は、つなぎ目の手前がすでに空白であることを表す
    if (before === "") return false;
    // 走査のマッチはドメインの . を含むので、. がなければ読み方は変わらない
    if (!before.includes(".") && !after.includes(".")) return false;
    // 長い本文に絵文字やリンクが並んでも、そのたびに語の全体を走査しないよう、関わる部分だけを比べる
    const [head, tail] = trimJoinContext(before, after);
    if (!spend(READING_SCAN_COST * (head.length + tail.length))) return true;
    // 後ろの語が結合文字で始まると、送る前の NFC への正規化で手前の文字と合成され、
    // URL の最後の文字が変わる（`https://a.co` + U+0301 が `https://a.có` になる）
    const isComposedWhenJoined =
      (head + tail).normalize("NFC") !==
      head.normalize("NFC") + tail.normalize("NFC");
    if (isComposedWhenJoined) return true;
    if (changesReadingWhenJoined(head, tail)) return true;
    // 手前の @ の直後には、後で defuseMentions がゼロ幅スペースを挟む。X にとって @ で
    // 遮られていたドメインがそこから始まり、続く本文を取り込むことがあるので、挟んだ後でも確かめる
    const defused = defuseMentions(head);
    return defused !== head && changesReadingWhenJoined(defused, tail);
  };
  return (getBefore, getAfter) => {
    if (budget < 0) return true;
    const befores = getBefore();
    const afters = getAfter();
    if (befores === undefined || afters === undefined) return true;
    return befores.some((before) =>
      afters.some((after) => changes(before, after)),
    );
  };
}

/**
 * リンクの変換で置いた目印を、必要なら空白に、不要なら消す。
 * 英数字の直後の URL は X がリンクにせず、前後の本文とつなげると X の読み方が変わるため、
 * そのときだけ空白で区切る。読み方が変わるかは、つなげた本文を findUrls と同じ走査で確かめる。
 * 前後のリンクの目印は消えるか空白になるので、両方の場合で確かめる。目印で打ち切るだけだと、
 * ラベルのないリンクが隣り合ったときに 1 つの URL につながる
 */
function resolveLinkMarkers(text: string): string {
  const changesReading = createReadingCheck();
  const textWords = lazyWords(text);
  const withEnds = text.replace(
    LINK_END_PATTERN,
    (_, url: string, offset: number) => {
      const restStart = offset + url.length + LINK_END.length;
      const startsTag = TAG_MARK_PATTERN.test(
        text.slice(restStart, restStart + 1),
      );
      const needsSeparator =
        startsTag ||
        changesReading(
          () => [url],
          () => textWords.after(restStart),
        );
      return needsSeparator ? `${url} ` : url;
    },
  );
  const words = lazyWords(withEnds);
  return withEnds
    .replace(
      LINK_START_PATTERN,
      (match: string, prev: string, offset: number) => {
        // 手前の本文が URL のパスやクエリなら、続けた URL を取り込んでしまう。
        // 手前がタグなら、URL を続けると X はハッシュタグとみなさなくなり、キャッシュタグは
        // 別のタグ（`$Ahttps`）に変わる
        const beforeEnd = offset + prev.length;
        const afterStart = offset + match.length;
        // 行頭や、ラベルの後ろの空白の直後は、すでに区切られている
        const isSeparated = prev === "" || SPACE_PATTERN.test(prev);
        const needsSeparator =
          !isSeparated &&
          (words.endsInTag(beforeEnd) ||
            changesReading(
              () => words.before(beforeEnd),
              () => words.after(afterStart),
            ));
        return needsSeparator ? `${prev} ` : prev;
      },
    )
    .replace(LINK_END_MARK_PATTERN, " ")
    .replace(MARKER_PATTERN, "");
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
 * 飛ばす範囲は urls で渡せる（既定は findUrls）。
 */
function replaceOutsideUrls(
  text: string,
  pattern: RegExp,
  replacer: (match: string, groups: string[], offset: number) => string,
  urls: readonly UrlMatch[] = findUrls(text),
): string {
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
// `:https://` の `:https:` は、findUrls が URL にしないリンク先のスキームなので除く
const CUSTOM_EMOJI = ":(?=[0-9+-]*[a-z_])(?!https?://)[a-z0-9_+-]+:";
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
  // 詰めるか区切るかを前後の語で決める箇所は、いったん目印にする。同じ語の中に絵文字が
  // 並ぶと、1 つずつ詰めても変わらないのに、まとめて詰めると読み方が変わることがある
  // （`https://a.com:a:.:b:jp` が `https://a.com.jp` になる）
  const marked = replaceOutsideUrls(
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
      // 絵文字の後ろの # は X がハッシュタグとして読むが、前の文字に詰めると読まなくなることがある
      const startsHashtag = HASHTAG_MARK_PATTERN.test(text.slice(end, end + 1));
      return startsHashtag ? " " : EMOJI_GAP;
    },
    // findUrls が URL にしない国際化ドメインの URL も、X はリンクにするので書き換えない
    findProtocolChunks(text),
  );
  if (!marked.includes(EMOJI_GAP)) return marked;
  const changesReading = createReadingCheck();
  const words = indexWords(marked);
  return marked.replace(EMOJI_GAP_PATTERN, (_: string, start: number) => {
    const end = start + EMOJI_GAP.length;
    // 英数字と URL の間や、URL の直後の絵文字を詰めると、X が URL とみなさなくなったり、
    // URL が後ろの本文を取り込んだりするので区切る。ほかの目印は、消える場合と空白になる
    // 場合の両方で確かめる（WordIndex を参照）。手前のタグに詰めると、別のタグに変わる
    const isJoinedDifferently =
      words.endsInTag(start) ||
      (words.hasDotAround(start, end) &&
        changesReading(
          () => words.before(start),
          () => words.after(end),
        ));
    return isJoinedDifferently ? " " : "";
  });
}

// メンションの記号。X は全角の ＠ もメンションの記号として扱う。
// 直前の文字を後読みにして、マッチを記号の 1 文字だけにする。直前の文字までマッチに含めると、
// 直前の文字が URL の末尾と重なるだけで置換を飛ばしてしまう。
// X は RT の直後の @ もメンションとして扱う（`RT@user` / `RT:@user`）。直前の文字と RT も
// 後読みにする。消費すると、連続する記号（`RT@RT@user`）の 2 つ目を置換できない
const MENTION_PATTERN =
  /(?<=^|[^\w@＠]|(?:^|[^A-Za-z0-9_+~.-])rt:?)[@＠](?=[A-Za-z0-9_])/gi;
const MENTION_MARK_PATTERN = /[@＠]/;
// 無害化を繰り返す回数の上限（defuseMentions を参照）
const MAX_DEFUSE_ROUNDS = 3;

/**
 * `@user` / `@user@host` が X 上の別ユーザーへのメンションにならないよう、
 * `@` の直後にゼロ幅スペースを挟む。
 */
export function defuseMentions(text: string): string {
  // 記号がなければ、URL を探す走査を省く
  if (!MENTION_MARK_PATTERN.test(text)) return text;
  const defuse = (mark: string) => `${mark}\u200B`;
  // ゼロ幅スペースを挟むと、@ で遮られていた `@host.tld?u=https://…/@user` のドメインを
  // X が URL として読み始め、後ろの URL を取り込む。中の @ が URL の外に出るので、
  // 変わらなくなるまで繰り返す。繰り返すたびに本文全体を走査するので、上限の回数を超えても
  // 変わり続けるときは、URL の中かどうかにかかわらず残りを無害化する（リンクは壊れうるが、
  // 通知は飛ばない）
  let out = text;
  for (let round = 0; round < MAX_DEFUSE_ROUNDS; round++) {
    const next = replaceOutsideUrls(out, MENTION_PATTERN, defuse);
    if (next === out) return out;
    out = next;
  }
  return out.replace(MENTION_PATTERN, defuse);
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
  // X は NFC に正規化してから読むので、区切りの判定も正規化した本文で行う。ケルビン記号
  // （U+212A）は NFC で K になり、直後の URL を止める
  body = stripMfm(body.normalize("NFC"));
  if (config.stripCustomEmoji) body = stripCustomEmoji(body);
  // BOM は X では直後の URL を止める文字だが、trim は空白として取り除く。無害化の後に取り除くと、
  // BOM の後ろで URL とみなして無害化しなかったメンションが、X では URL の外に出る。
  // MFM の記号やカスタム絵文字を取り除くと、文字と結合文字がつながって合成されることがあるので、
  // もう一度正規化する
  body = defuseMentions(body.trim().normalize("NFC"));

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
