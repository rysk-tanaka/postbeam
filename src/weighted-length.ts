/**
 * X の文字数カウント（twitter-text v3 の重み付けルールの簡易実装）。
 *
 * - 以下のコードポイント範囲は 1、それ以外（日本語など）は 2 として数える
 * - 絵文字は 1 書記素あたり 2
 * - URL は長さに関係なく 23。URL とみなす範囲は findUrls を参照。
 *   findUrls が拾わないプロトコル付きの文字列は、長さと 23 の大きいほう
 * - プロトコルなしのドメイン（`misskey.io`）は、長さと 23 の大きいほう。
 *   X が URL と判定するかは TLD の一覧などで決まるため、少なく数えて上限を
 *   超えないよう、多めに見積もる
 */
export const MAX_WEIGHTED_LENGTH = 280;
export const URL_WEIGHT = 23;

const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

// X（twitter-text）が URL とみなす範囲に合わせる。
// - 英数字や @ # $ の直後は URL にならない
// - ホストの TLD は GENERIC_TLDS の一覧か英字 2 文字に限る。X がリンクにしない URL
//   （localhost や example.invalid）を URL として扱うと、その中のメンションを無害化しなくなるため。
//   2 文字の TLD は実在するかを確認しないため、この部分だけは X より広い
// - パスとクエリは / か ? で始まり、ASCII の文字だけを含める。X は日本語の文字で URL を
//   打ち切り、クエリではアクセント付きの文字でも打ち切る。パスのアクセント付きの文字や
//   キリル文字は X が URL に含めるが、ここでは含めずに狭めに取る（リンクが壊れることは
//   あるが、通知は飛ばない）
// 一覧にも英字 2 文字にも当てはまらない TLD の URL は URL として扱わない。文字数は LOOSE_URL_PATTERN で
// 多めに数え、メンションは無害化される。リンクが壊れることはあるが、通知は飛ばない
const GENERIC_TLDS = [
  "com",
  "net",
  "org",
  "info",
  "biz",
  "edu",
  "gov",
  "mil",
  "int",
  "app",
  "dev",
  "page",
  "blog",
  "news",
  "xyz",
  "site",
  "online",
  "tech",
  "art",
  "design",
  "social",
  "space",
  "cloud",
  "shop",
  "store",
  "live",
  "club",
  "wiki",
  "games",
  "moe",
  "tokyo",
  "network",
  "world",
  "link",
  "work",
  "today",
  "garden",
  "systems",
  "zone",
  // Misskey のサーバーでよく使われる gTLD
  "ski",
  "cafe",
  "fun",
  "lol",
  "monster",
  "town",
  "place",
  "love",
  "chat",
  "ninja",
  "party",
  "rocks",
  "osaka",
  "kyoto",
  "nagoya",
];
// X はラベルの先頭と末尾に - や _ を置いたホストを URL にしない
const URL_HOST = String.raw`(?:(?![_-])[a-z0-9_-]+(?<![_-])\.)*(?!-)[a-z0-9-]+(?<!-)\.(?:[a-z]{2}|${GENERIC_TLDS.join("|")})(?![a-z0-9-])`;
const URL_PATH_CHAR = String.raw`[A-Za-z0-9!?*';:=+,.$/%#\[\]()\-_~&|@]`;
// この文字の直後にある https:// は、X が URL とみなさない
const URL_BLOCKING_PREFIX = "A-Za-z0-9@＠$#＃";
const URL_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<![${URL_BLOCKING_PREFIX}])https?://${URL_HOST}(?::\d+)?(?:[/?]${URL_PATH_CHAR}*)?`,
  "giu",
);
const URL_PATH_CHAR_PATTERN = new RegExp(`^${URL_PATH_CHAR}$`, "u");
const URL_BLOCKING_PREFIX_PATTERN = new RegExp(
  `^[${URL_BLOCKING_PREFIX}]$`,
  "u",
);
// X が URL の末尾に置ける文字。末尾にこれ以外の文字があれば URL に含めない
const URL_ENDING_CHAR_PATTERN = /^[A-Za-z0-9=_#/+\-)]$/u;
// findUrls が拾わないプロトコル付きの文字列（国際化ドメイン、一覧にも英字 2 文字にも当てはまらない TLD など）。
// X が URL とみなす場合に少なく数えないよう、長さと 23 の大きいほうで数える
// 日本語や全角の文字の手前で終える。続けて書いた本文まで 1 つのかたまりにすると、
// 切り詰めでまるごと落ちてしまうため。国際化ドメインは https:// だけが 23 になり、
// 残りは文字として数えるので、少なく数えることはない
const LOOSE_URL_PATTERN =
  /https?:\/\/[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF]*/giu;
// @ の直後のドメイン（リモートのメンション `@user@host` やメールアドレス）は X が URL にしない
const BARE_DOMAIN_PATTERN =
  /(?<![\w.@＠-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?![\w-])/giu;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export interface UrlMatch {
  start: number;
  end: number;
}

/**
 * 対応する相手のない括弧があれば、その手前までの長さを返す。
 * X は対応の取れた括弧しか URL に含めない。
 */
function balancedLength(candidate: string): number {
  const openers: { index: number; closer: string }[] = [];
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === "(" || c === "[") {
      openers.push({ index: i, closer: c === "(" ? ")" : "]" });
    } else if (c === ")" || c === "]") {
      // 種類の違う括弧は対応とみなさない（`(` を `]` で閉じない）
      const isMatched = openers.at(-1)?.closer === c;
      if (!isMatched) return Math.min(i, openers[0]?.index ?? i);
      openers.pop();
    }
  }
  // 閉じられないまま残った開き括弧があれば、最初のものの手前までにする
  return openers[0]?.index ?? candidate.length;
}

/**
 * URL の候補から、本文の一部とみなすべき部分を取り除く。
 * `(https://example.com)` の `)` や文末の `.` を URL に含めないため。
 */
function trimUrlCandidate(candidate: string): string {
  let url = candidate;
  // 末尾を外すと括弧の対応が崩れ、括弧で打ち切ると末尾が変わるので、変化がなくなるまで繰り返す
  let isChanged = true;
  while (isChanged) {
    let end = balancedLength(url);
    // 正規表現で末尾を外すと、句読点が長く続く入力でバックトラックが二乗になる
    while (end > 0 && !URL_ENDING_CHAR_PATTERN.test(url[end - 1] ?? "")) {
      end--;
    }
    isChanged = end !== url.length;
    url = url.slice(0, end);
  }
  return url;
}

/** 直前の URL に続けて書くと、URL の一部として読まれる文字か */
export function continuesUrl(char: string): boolean {
  return URL_PATH_CHAR_PATTERN.test(char);
}

/** URL の末尾にあると、URL に含めない文字か */
export function isTrimmedFromUrlEnd(char: string): boolean {
  return !URL_ENDING_CHAR_PATTERN.test(char);
}

/** 直後に書いた URL を、X が URL とみなさなくなる文字か */
export function blocksFollowingUrl(char: string): boolean {
  return URL_BLOCKING_PREFIX_PATTERN.test(char);
}

/** 本文中のプロトコル付き URL の位置を返す */
export function findUrls(text: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  const pattern = new RegExp(URL_CANDIDATE_PATTERN);
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const start = m.index;
    const end = start + trimUrlCandidate(m[0]).length;
    matches.push({ start, end });
    // 打ち切った後ろに別の URL が続く場合に備え、打ち切り位置から探し直す
    pattern.lastIndex = end;
  }
  return matches;
}

function codePointWeight(cp: number): number {
  for (const [lo, hi] of LIGHT_RANGES) {
    if (cp >= lo && cp <= hi) return 1;
  }
  return 2;
}

function graphemeWeight(g: string): number {
  if (EMOJI_PATTERN.test(g)) return 2;
  let w = 0;
  for (const ch of g) w += codePointWeight(ch.codePointAt(0) ?? 0);
  return w;
}

function plainWeight(s: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(s)) w += graphemeWeight(segment);
  return w;
}

interface Token {
  text: string;
  weight: number;
}

/** URL とドメインを 1 つのかたまりとして扱いながら、書記素単位に分割する */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pushPlain = (s: string) => {
    for (const { segment } of segmenter.segment(s)) {
      tokens.push({ text: segment, weight: graphemeWeight(segment) });
    }
  };
  const pushDomains = (s: string) => {
    let last = 0;
    for (const m of s.matchAll(BARE_DOMAIN_PATTERN)) {
      pushPlain(s.slice(last, m.index));
      tokens.push({ text: m[0], weight: Math.max(m[0].length, URL_WEIGHT) });
      last = m.index + m[0].length;
    }
    pushPlain(s.slice(last));
  };
  const pushOutsideUrl = (s: string) => {
    let last = 0;
    for (const m of s.matchAll(LOOSE_URL_PATTERN)) {
      pushDomains(s.slice(last, m.index));
      tokens.push({
        text: m[0],
        weight: Math.max(plainWeight(m[0]), URL_WEIGHT),
      });
      last = m.index + m[0].length;
    }
    pushDomains(s.slice(last));
  };
  let last = 0;
  for (const { start, end } of findUrls(text)) {
    pushOutsideUrl(text.slice(last, start));
    tokens.push({ text: text.slice(start, end), weight: URL_WEIGHT });
    last = end;
  }
  pushOutsideUrl(text.slice(last));
  return tokens;
}

export function weightedLength(text: string): number {
  return tokenize(text.normalize("NFC")).reduce((sum, t) => sum + t.weight, 0);
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/**
 * 重み付き文字数が max を超える場合、末尾を切り詰めて ellipsis を付ける。
 * URL とドメインは途中で切らず、入りきらなければまるごと落とす。
 */
export function truncateWeighted(
  text: string,
  max: number = MAX_WEIGHTED_LENGTH,
  ellipsis = "…",
): TruncateResult {
  const normalized = text.normalize("NFC");
  const tokens = tokenize(normalized);
  const total = tokens.reduce((sum, t) => sum + t.weight, 0);
  if (total <= max) {
    return { text: normalized, truncated: false };
  }
  const budget = max - weightedLength(ellipsis);
  let used = 0;
  let out = "";
  for (const token of tokens) {
    if (used + token.weight > budget) break;
    out += token.text;
    used += token.weight;
  }
  return { text: out.trimEnd() + ellipsis, truncated: true };
}
