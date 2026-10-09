/**
 * X の文字数カウント（twitter-text v3 の重み付けルールの簡易実装）。
 *
 * - 以下のコードポイント範囲は 1、それ以外（日本語など）は 2 として数える
 * - 絵文字を含む書記素は、標準の絵文字（RGI）の並びなら 2。それ以外（`❤︎` のような
 *   テキスト表示の記号や、標準にない ZWJ・肌色の組み合わせ）は、文字ごとの重みの合計で
 *   数え、最低 2 とする。`❤︎` や `🐱‍👤` のような単純な並びでは X と同じ値になる。
 *   X は表にある部分列を 2 と数え、`©` を 1 と数えるので、こちらのほうが多くなることがある。
 *   `🇯🇵` のような地域指示子の旗とキーキャップは文字ごとの合計で、X より多めになる
 * - twitter-text の絵文字の表（twemoji-parser 11）より新しい並びは、twitter-text 3.1.0 では
 *   文字ごとに数えられるが、ここでは RGI として 2 と数える。`🫃🏻` や `🐦‍🔥` がこれに当たる。
 *   多めに数える方針の例外で、X が古い表を使っていれば少なく数えて上限を超えうる。
 *   X のサーバーがどの表を使っているかは確かめられず、よく使う絵文字を一律に多めに数えると
 *   切り詰めが早まりすぎるため、RGI の並びは一律 2 と数える
 * - URL は長さに関係なく 23。URL とみなす範囲は findUrls を参照。
 *   findUrls が拾わないプロトコル付きの文字列（日本語の手前まで）は、中のドメインも 23 以上として
 *   数えた重みと 23 の大きいほうに、2 つ目以降のプロトコル 1 つごとに 23 を足す。
 *   X がかたまりの先頭だけを URL とみなす場合（`https://é.co!!!` のように、漢字やかな以外の
 *   国際化ドメイン）は、X より少なくなることがある（LOOSE_URL_PATTERN を参照）
 * - プロトコルなしのドメイン（`misskey.io`）は、長さと 23 の大きいほう。TLD は X の一覧で
 *   判定するが、X が URL とみなすか（直前の文字など）までは確かめないので、URL とみなす場合の
 *   23 と、みなさない場合の長さの大きいほうで多めに見積もる。例外として、ラベルにアクセント付きの
 *   文字を含むドメイン（`café.com`）はドメインとして数えず、X より少なくなる
 *   （BARE_DOMAIN_LABELS_PATTERN を参照）
 */
import { COUNTRY_TLDS, GENERIC_TLDS } from "./tlds";

export const MAX_WEIGHTED_LENGTH = 280;
export const URL_WEIGHT = 23;

const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

// 以下は twitter-text 3.1.0 の dist/regexp/ の正規表現をもとにしたもの。X が文字列を走査して
// URL を見つける手順（extractUrlsWithIndices）を再現するために使う。TLD の一覧は tlds.ts
const LATIN_ACCENT_CHARS =
  "\\xC0-\\xD6\\xD8-\\xF6\\xF8-\\xFF\\u0100-\\u024F\\u0253\\u0254\\u0256\\u0257\\u0259\\u025B\\u0263\\u0268\\u026F\\u0272\\u0289\\u028B\\u02BB\\u0300-\\u036F\\u1E00-\\u1EFF";
const CYRILLIC_CHARS = "\\u0400-\\u04FF";
const INVALID_CHARS = "\\uFFFE\\uFEFF\\uFFFF";
const DIRECTIONAL_MARKERS =
  "\\u202A-\\u202E\\u061C\\u200E\\u200F\\u2066\\u2067\\u2068\\u2069";
const SPACES =
  "\\x09-\\x0D\\x20\\x85\\xA0\\u1680\\u180E\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
// X が空白とみなす文字。BOM（U+FEFF）は含まない
export const SPACE_PATTERN = new RegExp(`[${SPACES}]`, "u");
const PUNCT = String.raw`!'#%&()*+,\\\-./:;<=>?@\[\]^_{|}~$`;
// この文字の直後にある URL は、X が URL とみなさない
const URL_BLOCKING_PREFIX = `A-Za-z0-9@＠$#＃${INVALID_CHARS}`;
// X はドメインに記号と空白以外の文字（日本語など）を許す
const DOMAIN_CHAR = `[^${PUNCT}${SPACES}${INVALID_CHARS}${DIRECTIONAL_MARKERS}]`;
// ラベル（ドメインの文字と _ と -）の並び
const LABEL_PATTERN = new RegExp(`(?:${DOMAIN_CHAR}|[_-])*`, "y");
const PATH_CHAR = String.raw`[a-z${CYRILLIC_CHARS}0-9!*';:=+,.$/%#\[\]\-\u2013_~@|&${LATIN_ACCENT_CHARS}]`;
// X は対応の取れた丸括弧を、内側にもう 1 組（1 段）まで URL に含める
const BALANCED_PARENS = String.raw`\((?:${PATH_CHAR}+|${PATH_CHAR}*\(${PATH_CHAR}+\)${PATH_CHAR}*)\)`;
const PATH_ENDING_CHAR = String.raw`[+\-a-z${CYRILLIC_CHARS}0-9=_#/${LATIN_ACCENT_CHARS}]`;
// twitter-text は末尾の文字の規則（文字クラスか括弧の組）を括弧で包まずに埋め込むため、
// 括弧の組は、それだけで 1 つのセグメントになるときにだけ末尾に置ける。
// `/a.(@user)` では URL を `/a` までとし、`@user` はメンションになる
// 括弧の組の選択肢を先に試す。twitter-text の順では、括弧の組が続くパスで長さの二乗の
// バックトラックになる。順を変えてもマッチする範囲が変わらないことは、ファズで確かめた
const PATH_SEGMENT = `(?:${BALANCED_PARENS}|${PATH_CHAR}*(?:${BALANCED_PARENS}${PATH_CHAR}*)*${PATH_ENDING_CHAR}|@${PATH_CHAR}+/)`;
// クエリはパスと違ってアクセント付きの文字とキリル文字を含めない
const QUERY_CHAR = String.raw`[a-z0-9!?*'@();:&=+$/%#\[\]\-_.,~|]`;
const QUERY_ENDING_CHAR = String.raw`[a-z0-9\-_&=#/]`;
// ドメインの後ろのポート・パス・クエリ。位置を指定してマッチさせるので sticky にする
const URL_REST_PATTERN = new RegExp(
  `(?::[0-9]+)?(?:/${PATH_SEGMENT}*)?(?:\\?${QUERY_CHAR}*${QUERY_ENDING_CHAR})?`,
  "iy",
);
const PROTOCOL_AT_PATTERN = /https?:\/\//iy;
const URL_BLOCKING_PREFIX_PATTERN = new RegExp(`^[${URL_BLOCKING_PREFIX}]$`);
// X は TLD の一覧を順に試し、直後が英数字・@・+・- でない最初のものを TLD とする。一覧から
// 正規表現を作るとコンパイルに数十 ms かかるので、一覧を引いて確かめる。英数字の TLD は
// 直後に英数字や - を置けないので、英数字と - の並びの全体が一覧にあるかだけを見ればよい。
// それ以外（日本語などを含む TLD）は、先頭の文字ごとに分けて X と同じ順に試す。
// 大文字と小文字は、X の正規表現（u フラグのない i）と同じく canonicalize でそろえて比べる
const TLDS = [...GENERIC_TLDS, ...COUNTRY_TLDS];
const ASCII_TLDS = new Set(TLDS.filter((tld) => /^[a-z0-9-]+$/.test(tld)));
const OTHER_TLDS_BY_FIRST_CHAR = new Map<string, string[]>();
for (const tld of TLDS.filter((tld) => !ASCII_TLDS.has(tld))) {
  const canonical = canonicalize(tld);
  const first = canonical[0] ?? "";
  const bucket = OTHER_TLDS_BY_FIRST_CHAR.get(first);
  if (bucket === undefined) OTHER_TLDS_BY_FIRST_CHAR.set(first, [canonical]);
  else bucket.push(canonical);
}
const ASCII_LABEL_PATTERN = /[0-9a-z-]+/iy;
const TLD_FOLLOWER_PATTERN = /^[0-9a-zA-Z@+-]$/;
const PUNYCODE_TLD_PATTERN = /^xn--[-0-9a-z]+$/i;
// X は xn-- で始まるドメインを、英数字のドメイン（validAsciiDomain）を含まなければ URL にしない
const PUNYCODE_HOST_PREFIX = "xn--";
const NON_ASCII_DOMAIN_CHAR_PATTERN = /[^-a-z0-9.]/i;
// 走査のマッチのドメインの部分の文字、それより後ろ（ポート・パス・クエリ）の文字、マッチの最後に置ける文字。
// X の正規表現でも同じ集合になる（isScanSyncPoint を参照）
const DOMAIN_PART_CHAR_PATTERN = new RegExp(`^(?:${DOMAIN_CHAR}|[._-])$`);
const URL_TAIL_CHAR_PATTERN = new RegExp(
  `^(?:${PATH_CHAR}|${QUERY_CHAR}|[():/?0-9])$`,
  "i",
);
const URL_LAST_CHAR_PATTERN = new RegExp(
  `^(?:${PATH_ENDING_CHAR}|${QUERY_ENDING_CHAR}|[)0-9])$`,
  "i",
);
const MAX_LABEL_LENGTH = 63;
// X はプロトコルの長さと URL の長さ（プロトコルを含む）の和がこれを超える URL を URL にしない
const MAX_URL_LENGTH = 4096;
// X は t.co の URL をスラッグとクエリまでに縮め、スラッグが長すぎれば URL にしない
const TCO_URL_PATTERN = new RegExp(
  String.raw`^https?:\/\/t\.co\/([a-z0-9]+)(?:\?${QUERY_CHAR}*${QUERY_ENDING_CHAR})?`,
  "i",
);
const MAX_TCO_SLUG_LENGTH = 40;
const DOMAIN_CHAR_PATTERN = new RegExp(`^${DOMAIN_CHAR}$`);
// ドメインになりうる、ラベルと . の並び
const DOMAIN_SEGMENT_PATTERN = new RegExp(`(?:${DOMAIN_CHAR}|[._-])+`, "g");
const PROTOCOL_PATTERN = /https?:\/\//gi;
// findUrls が拾わないプロトコル付きの文字列（国際化ドメインや、X の一覧にない TLD など）。
// X が URL とみなす場合に少なく数えないよう、中のドメインも 23 以上として数えた重みと 23 の大きいほうで数える
// 日本語や全角の文字の手前で終える。続けて書いた本文まで 1 つのかたまりにすると、
// 切り詰めでまるごと落ちてしまうため。漢字やかなのホストは https:// だけが 23 になり、
// 残りは文字として数える。かたまりの中の 2 つ目以降のプロトコルからは、X が国際化ドメインの
// URL（`?u=http://日本.com`）を始めることがあるので、1 つごとに 23 を足す。
// アクセント付きの文字を含むホストのように、X がかたまりの一部だけを URL とみなし、
// 残りを文字として数える場合は、少なく数えることがある
const LOOSE_URL_PATTERN =
  /https?:\/\/[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303F\uFF00-\uFFEF]*/giu;
// プロトコルのないドメインの、TLD の手前までのラベルの並び（bareDomains を参照）。
// @ の直後のドメイン（リモートのメンション `@user@host` やメールアドレス）は X が URL にしない。
// X は日本語や全角の ＠ もドメインの文字として読み、その中の英数字のドメインを URL にするので、
// _・.・＠ の直後からも数える。X の validAsciiDomain と違い、ラベルにアクセント付きの文字を
// 含めないので、`café.com` は X（23）より少なく数える。
// X の validDomain は、2 つ目以降のラベルの先頭と末尾に - を許さず、その手前でドメインを終える。
// - をまたいで読むと、`misskey.io.-example.com` を 1 つのドメイン（23）と数えてしまう（X は 36）
const BARE_DOMAIN_LABELS_PATTERN =
  /(?<![a-z0-9@-])[a-z0-9-]+\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*/giu;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
// biome-ignore lint/complexity/useRegexLiterals: TS は target が ES2024 より前だと v フラグのリテラルをエラーにする
const RGI_EMOJI_PATTERN = new RegExp("^\\p{RGI_Emoji}$", "v");

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export interface UrlMatch {
  start: number;
  end: number;
}

/**
 * X がプロトコル付きの URL として認める長さを返す。認めなければ undefined。
 * match は走査でマッチした URL の部分、host はそのドメイン
 */
function acceptedUrlLength(
  match: string,
  protocol: string,
  host: string,
): number | undefined {
  // X はドメインを Punycode に変換して確かめ、ラベルが空か長すぎれば URL にしない。日本語などを
  // 含むドメインの変換後の長さはここでは求めないので、含むときは一律に URL にしない（狭い側）
  const labels = host.split(".");
  const isAsciiHost = !/[^ -~]/.test(host);
  const hasValidLabels = labels.every(
    (label) => label.length >= 1 && label.length <= MAX_LABEL_LENGTH,
  );
  if (!isAsciiHost || !hasValidLabels) return undefined;
  // 英数字と - と . だけのホストは、それ自体が英数字のドメインになる。それ以外の文字を含むものは
  // 英数字のドメインを含むかを確かめずに URL にしない（狭い側）
  const isPunycode = host.startsWith(PUNYCODE_HOST_PREFIX);
  const hasNonAsciiDomainChar = NON_ASCII_DOMAIN_CHAR_PATTERN.test(host);
  if (isPunycode && hasNonAsciiDomainChar) return undefined;
  // X は長さの上限を、t.co の URL を縮める前に確かめる
  if (protocol.length + match.length > MAX_URL_LENGTH) return undefined;
  const tco = TCO_URL_PATTERN.exec(match);
  if (!tco) return match.length;
  const slug = tco[1] ?? "";
  return slug.length > MAX_TCO_SLUG_LENGTH ? undefined : tco[0].length;
}

/**
 * 位置ごとに、そこから URL（プロトコルなしのドメインを含む）が始まりうるかを返す。
 * ドメインの文字は日本語も含むので、句読点のない長い本文では、正規表現をすべての位置で
 * 試すと、失敗するたびにラベルと . の並びの終わりまで読み直し、長さの二乗の時間がかかる。
 * ドメインとして読める位置とプロトコルの始まりだけを試し、それ以外は飛ばす
 */
function urlStartFlags(text: string): Uint8Array {
  const flags = new Uint8Array(text.length + 1);
  // 文字ごとに正規表現を試すと遅いので、並びとプロトコルをまとめて探す
  for (const segment of text.matchAll(DOMAIN_SEGMENT_PATTERN)) {
    // ドメインはラベル、.、TLD の少なくとも 3 文字
    const mayBeDomain = segment[0].length >= 3 && segment[0].includes(".");
    if (mayBeDomain) markDomainStarts(text, segment.index, segment[0], flags);
  }
  for (const m of text.matchAll(PROTOCOL_PATTERN)) flags[m.index] = 1;
  return flags;
}

/**
 * text の offset から始まるラベルと . の並びの中で、X の validDomain として読める位置に印を付ける。
 * validDomain は、サブドメイン（記号で始まらず終わらないラベル）を続けた後、_ を含まないラベルと
 * TLD で終わる。読めるかどうかはラベルごとに決まるので、後ろのラベルから求めておく
 */
function markDomainStarts(
  text: string,
  offset: number,
  segment: string,
  flags: Uint8Array,
): void {
  const labels = segment.split(".");
  const starts: number[] = [];
  let position = offset;
  for (const label of labels) {
    starts.push(position);
    position += label.length + 1;
  }
  const isTld = (k: number): boolean => {
    const start = starts[k];
    return k > 0 && start !== undefined && tldLengthAt(text, start) > 0;
  };
  const endsWithDomainChar = (label: string) =>
    DOMAIN_CHAR_PATTERN.test(label.at(-1) ?? "");
  // canStartAt[k]: ラベル k の全体を最初のラベルとして、ドメインを読めるか
  const canStartAt = new Array<boolean>(labels.length + 1).fill(false);
  const isTldAt = labels.map((_, k) => isTld(k)).concat(false);
  for (let k = labels.length - 1; k >= 0; k--) {
    const label = labels[k] ?? "";
    const isSubdomain =
      DOMAIN_CHAR_PATTERN.test(label[0] ?? "") && endsWithDomainChar(label);
    const isDomainName = isSubdomain && !label.includes("_");
    canStartAt[k] =
      (isDomainName && isTldAt[k + 1] === true) ||
      (isSubdomain && canStartAt[k + 1] === true);
  }
  // ラベルの途中から始めるときは、その位置から後ろをラベルとして読む
  labels.forEach((label, k) => {
    if (!endsWithDomainChar(label)) return;
    const lastUnderscore = label.lastIndexOf("_");
    const start = starts[k] ?? 0;
    for (let i = 0; i < label.length; i++) {
      if (!DOMAIN_CHAR_PATTERN.test(label[i] ?? "")) continue;
      const canEndAfter = i > lastUnderscore && isTldAt[k + 1] === true;
      if (canEndAfter || canStartAt[k + 1] === true) flags[start + i] = 1;
    }
  });
}

/** 走査の 1 回のマッチ。url は X が URL として認めた範囲（認めなければ undefined） */
interface ScanMatch {
  start: number;
  /** 走査が消費した範囲の終わり。X は次の URL をここから探す */
  consumedEnd: number;
  url?: UrlMatch;
}

/**
 * u フラグのない i の正規表現と同じく、1 文字（UTF-16 の単位）ずつ大文字にそろえる。
 * 大文字が 1 文字にならない文字と、ASCII の外から ASCII に変わる文字はそのまま残す。
 * toLowerCase で比べると、`ϵ`（大文字は Ε）のように X と結果が分かれる文字がある
 */
function canonicalize(s: string): string {
  let out = "";
  for (const unit of s.split("")) {
    const upper = unit.toUpperCase();
    const isKept =
      upper.length !== 1 ||
      (unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128);
    out += isKept ? unit : upper;
  }
  return out;
}

/** text の index から X の TLD が始まれば、その長さ。始まらなければ 0 */
function tldLengthAt(text: string, index: number): number {
  ASCII_LABEL_PATTERN.lastIndex = index;
  const run = ASCII_LABEL_PATTERN.exec(text)?.[0] ?? "";
  const follower = text[index + run.length];
  const isListed =
    ASCII_TLDS.has(run.toLowerCase()) && follower !== "@" && follower !== "+";
  if (isListed) return run.length;
  const first = canonicalize(text[index] ?? "");
  for (const tld of OTHER_TLDS_BY_FIRST_CHAR.get(first) ?? []) {
    const end = index + tld.length;
    const isTld =
      canonicalize(text.slice(index, end)) === tld &&
      !TLD_FOLLOWER_PATTERN.test(text[end] ?? "");
    if (isTld) return tld.length;
  }
  // X は一覧の後に Punycode（xn--…）を試す。こちらは直後の文字を見ない
  return PUNYCODE_TLD_PATTERN.test(run) ? run.length : 0;
}

/** 位置から X の validDomain が読むドメインの終わりを返す。読めなければ undefined */
type DomainEndReader = (start: number) => number | undefined;

/**
 * text の DomainEndReader を作る。X の正規表現と同じく、サブドメイン（記号で始まらず終わらない
 * ラベル）を貪欲に読んでから、TLD の手前のラベル（_ を含まない）と TLD の組を後ろから順に試す。
 * 結果は、次のラベルから読んだ結果があればそれ、なければ最初のラベルと TLD の組になるので、
 * ラベルの始まりごとの結果を覚えておく。`_x.jp` が続く本文のように短いマッチが並んでも、
 * マッチのたびにラベルの並びを終わりまで読み直さず、長さの二乗の時間にならない。
 * 覚えた結果は text に結びつくので、走査ごとに作る
 */
function createDomainEndReader(text: string): DomainEndReader {
  // null は、ドメインを読めないと決まった位置
  const ends = new Map<number, number | null>();
  return (start) => {
    const labels: { start: number; dot: number; hasUnderscore: boolean }[] = [];
    let end: number | null = null;
    for (let labelStart = start; ; ) {
      const known = ends.get(labelStart);
      if (known !== undefined) {
        end = known;
        break;
      }
      LABEL_PATTERN.lastIndex = labelStart;
      const label = LABEL_PATTERN.exec(text)?.[0] ?? "";
      const dot = labelStart + label.length;
      const isSubdomain =
        DOMAIN_CHAR_PATTERN.test(label[0] ?? "") &&
        DOMAIN_CHAR_PATTERN.test(label.at(-1) ?? "") &&
        text[dot] === ".";
      if (!isSubdomain) {
        ends.set(labelStart, null);
        break;
      }
      labels.push({
        start: labelStart,
        dot,
        hasUnderscore: label.includes("_"),
      });
      labelStart = dot + 1;
    }
    for (const { start: labelStart, dot, hasUnderscore } of labels.reverse()) {
      const tldLength =
        end !== null || hasUnderscore ? 0 : tldLengthAt(text, dot + 1);
      if (tldLength > 0) end = dot + 1 + tldLength;
      ends.set(labelStart, end);
    }
    return end ?? undefined;
  };
}

/**
 * text の start から始まる URL（プロトコルなしのドメインを含む）の走査のマッチ。
 * domainEndAt は text から作ったもの（createDomainEndReader を参照）
 */
function matchUrlAt(
  text: string,
  start: number,
  domainEndAt: DomainEndReader,
): ScanMatch | undefined {
  PROTOCOL_AT_PATTERN.lastIndex = start;
  const protocol = PROTOCOL_AT_PATTERN.exec(text)?.[0] ?? "";
  const hostStart = start + protocol.length;
  const hostEnd = domainEndAt(hostStart);
  if (hostEnd === undefined) return undefined;
  URL_REST_PATTERN.lastIndex = hostEnd;
  URL_REST_PATTERN.exec(text);
  const consumedEnd = URL_REST_PATTERN.lastIndex;
  // プロトコルのないドメインは URL として返さず、文字数の側で多めに数える
  if (!protocol) return { start, consumedEnd };
  const match = text.slice(start, consumedEnd);
  const host = text.slice(hostStart, hostEnd);
  const length = acceptedUrlLength(match, protocol, host);
  const url = length === undefined ? undefined : { start, end: start + length };
  return { start, consumedEnd, url };
}

/**
 * text の index からの走査のマッチ。X は直前の 1 文字を消費してから URL を探す
 * （`([^A-Za-z0-9@＠$#＃…]|^)`）。直前の URL の最後の文字を、次の URL の直前の文字として
 * 使い回さないため。本文の先頭では、直前の文字なしでも試す
 */
function scanAt(
  text: string,
  index: number,
  domainEndAt: DomainEndReader,
): ScanMatch | undefined {
  const isBlocked = URL_BLOCKING_PREFIX_PATTERN.test(text[index] ?? "");
  const match = isBlocked
    ? undefined
    : matchUrlAt(text, index + 1, domainEndAt);
  if (match !== undefined || index !== 0) return match;
  return matchUrlAt(text, 0, domainEndAt);
}

/**
 * 走査がどこから来ても、index の文字を直前の文字として必ず試し、そこからは同じように続く位置か。
 * その文字がドメインの部分にもマッチの最後にも置けず、ポート・パス・クエリの途中にも
 * 置けない（その文字か次の文字がそれらに使えない）なら、どのマッチもその文字を含まない
 */
function isScanSyncPoint(text: string, index: number): boolean {
  const char = text[index] ?? "";
  if (DOMAIN_PART_CHAR_PATTERN.test(char)) return false;
  if (URL_LAST_CHAR_PATTERN.test(char)) return false;
  if (!URL_TAIL_CHAR_PATTERN.test(char)) return true;
  return !URL_TAIL_CHAR_PATTERN.test(text[index + 1] ?? "");
}

/** X と同じく、消費した範囲の後ろから次を探しながら、走査のマッチを順に返す */
function* scanUrls(text: string): Generator<ScanMatch> {
  const canStart = urlStartFlags(text);
  const domainEndAt = createDomainEndReader(text);
  // マッチは直前の 1 文字（本文の先頭では空）から始まるので、その次の位置で判定する
  const isCandidate = (index: number) =>
    canStart[index + 1] === 1 || (index === 0 && canStart[0] === 1);
  let index = 0;
  while (index < text.length) {
    const scan = isCandidate(index)
      ? scanAt(text, index, domainEndAt)
      : undefined;
    if (scan === undefined) {
      index++;
      continue;
    }
    yield scan;
    index = scan.consumedEnd;
  }
}

/**
 * 本文中のプロトコル付き URL の位置を返す。
 * twitter-text の正規表現をもとに走査し、プロトコルのないドメインや URL にしないかたまりも、
 * X と同じく消費したまま次を探す。そうしないと、X が URL にしないかたまりの中の
 * `https://…/@user` を URL とみなし、メンションを無害化しなくなる
 */
export function findUrls(text: string): UrlMatch[] {
  const matches: UrlMatch[] = [];
  for (const { url } of scanUrls(text)) {
    if (url) matches.push(url);
  }
  return matches;
}

/**
 * 本文中の、プロトコルで始まる走査のかたまりの位置。X が URL とみなすかによらず、走査が
 * 消費した範囲を返す。findUrls が URL にしない国際化ドメインの URL も含むので、中を書き換えると
 * X のリンク先が変わりうる範囲として使う。広い側にずれるので、メンションの無害化には使わない
 */
export function findProtocolChunks(text: string): UrlMatch[] {
  const chunks: UrlMatch[] = [];
  for (const { start, consumedEnd } of scanUrls(text)) {
    PROTOCOL_AT_PATTERN.lastIndex = start;
    if (PROTOCOL_AT_PATTERN.test(text)) {
      chunks.push({ start, end: consumedEnd });
    }
  }
  return chunks;
}

/** 走査のマッチを比べるためのキー。offset だけずらす */
function scanKeys(text: string, offset = 0): string[] {
  return Array.from(scanUrls(text), ({ start, consumedEnd, url }) =>
    [start, consumedEnd, url?.start ?? -1, url?.end ?? -1]
      .map((n) => (n < 0 ? n : n + offset))
      .join(),
  );
}

/**
 * before と after を続けたときの読み方に関わる部分だけを返す。つなぎ目から離れた同期点（isScanSyncPoint）より
 * 外側は、続けても区切っても同じように走査されるので、比べなくてよい
 */
export function trimJoinContext(
  before: string,
  after: string,
): [string, string] {
  let start = before.length - 2;
  while (start >= 0 && !isScanSyncPoint(before, start)) start--;
  let end = 0;
  while (end < after.length && !isScanSyncPoint(after, end)) end++;
  return [before.slice(Math.max(start, 0)), after.slice(0, end + 1)];
}

/**
 * before の直後に after を続けると、空白で区切ったときと X の読み方（URL と認める範囲と、
 * 走査が消費する範囲）が変わるか。走査がまたぐ場合のほか、after の先頭の文字で before の
 * URL が終わらなくなる場合や、before の最後の文字で after の URL が URL でなくなる場合も変わる
 */
export function changesReadingWhenJoined(
  before: string,
  after: string,
): boolean {
  // after だけを走査すると、先頭の文字を直前の文字として消費する読み方を先に試すので、
  // 空白で区切ったときと読み方が変わる（`あb.com` を `b.com` と読む）。空白を付けて走査する
  const separate = [
    ...scanKeys(before),
    ...scanKeys(` ${after}`, before.length - 1),
  ];
  const joined = scanKeys(before + after);
  return (
    joined.length !== separate.length ||
    joined.some((key, i) => key !== separate[i])
  );
}

function codePointWeight(cp: number): number {
  for (const [lo, hi] of LIGHT_RANGES) {
    if (cp >= lo && cp <= hi) return 1;
  }
  return 2;
}

function graphemeWeight(g: string): number {
  let w = 0;
  for (const ch of g) w += codePointWeight(ch.codePointAt(0) ?? 0);
  // 旗（地域指示子）やキーキャップは絵文字の記号を含まないので、文字ごとの合計のまま多めに数える
  if (!EMOJI_PATTERN.test(g)) return w;
  if (RGI_EMOJI_PATTERN.test(g)) return 2;
  // X は © などを 1 と数えるが、少なく数えないよう 2 と数える
  return Math.max(w, 2);
}

function plainWeight(s: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(s)) w += graphemeWeight(segment);
  return w;
}

/**
 * text の from から to までの中のプロトコルなしのドメイン。X の validAsciiDomain と同じく、ラベルの並びを貪欲に読んでから、
 * TLD を後ろの . から順に試す（ラベルの文字は BARE_DOMAIN_LABELS_PATTERN を参照）
 */
function* bareDomains(
  text: string,
  from: number,
  to: number,
): Generator<{ index: number; text: string }> {
  const pattern = new RegExp(BARE_DOMAIN_LABELS_PATTERN);
  // 範囲の外の文字も、ドメインの直前の文字や TLD の直後の文字として見る。範囲だけを
  // 切り出すと、URL の直前の `みんなhttps://…` の `みんな` を TLD とみなしてしまう
  const head = text.slice(0, to);
  pattern.lastIndex = from;
  for (let m = pattern.exec(head); m !== null; m = pattern.exec(head)) {
    const labels = m[0];
    for (
      let dot = labels.length - 1;
      dot >= 0;
      dot = labels.lastIndexOf(".", dot - 1)
    ) {
      const tldStart = m.index + dot + 1;
      const end = tldStart + tldLengthAt(text, tldStart);
      if (end === tldStart || end > to) {
        if (dot === 0) break;
        continue;
      }
      yield { index: m.index, text: text.slice(m.index, end) };
      pattern.lastIndex = end;
      break;
    }
  }
}

/**
 * プロトコルなしのドメインの重み。X が URL とみなせば 23、みなさなければ文字ごとの重み
 * （`みんな` などの TLD は 1 文字 2）なので、その大きいほう
 */
function domainWeight(domain: string): number {
  return Math.max(plainWeight(domain), URL_WEIGHT);
}

/** text の start から end までを、中のプロトコルなしのドメインを domainWeight として数える */
function domainAwareWeight(text: string, start: number, end: number): number {
  let w = 0;
  let last = start;
  for (const domain of bareDomains(text, start, end)) {
    w += plainWeight(text.slice(last, domain.index));
    w += domainWeight(domain.text);
    last = domain.index + domain.text.length;
  }
  return w + plainWeight(text.slice(last, end));
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
  const pushDomains = (start: number, end: number) => {
    let last = start;
    for (const domain of bareDomains(text, start, end)) {
      pushPlain(text.slice(last, domain.index));
      tokens.push({ text: domain.text, weight: domainWeight(domain.text) });
      last = domain.index + domain.text.length;
    }
    pushPlain(text.slice(last, end));
  };
  const pushOutsideUrl = (start: number, end: number) => {
    let last = start;
    for (const m of text.slice(start, end).matchAll(LOOSE_URL_PATTERN)) {
      const chunkStart = start + m.index;
      const chunkEnd = chunkStart + m[0].length;
      pushDomains(last, chunkStart);
      // X は、かたまりの中の後ろのドメイン（`https://example.com+misskey.io` の
      // `misskey.io`）を URL として数えることがある。どれを数えるかは前後の文字で
      // 変わるため、中のドメインをすべて 23 以上として多めに数える
      const innerProtocols = (m[0].match(PROTOCOL_PATTERN)?.length ?? 1) - 1;
      tokens.push({
        text: m[0],
        weight:
          Math.max(domainAwareWeight(text, chunkStart, chunkEnd), URL_WEIGHT) +
          URL_WEIGHT * innerProtocols,
      });
      last = chunkEnd;
    }
    pushDomains(last, end);
  };
  let last = 0;
  for (const { start, end } of findUrls(text)) {
    pushOutsideUrl(last, start);
    tokens.push({ text: text.slice(start, end), weight: URL_WEIGHT });
    last = end;
  }
  pushOutsideUrl(last, text.length);
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
  let kept = 0;
  for (const token of tokens) {
    if (used + token.weight > budget) break;
    used += token.weight;
    kept++;
  }
  // 語の途中で切ると、残り（`photo.jpeg` の `photo.jp`）を X が URL として数え、
  // 上限を超えることがある。切った後の本文を数え直し、超えていれば末尾のトークンを戻す
  for (; ; kept--) {
    const out = `${tokens
      .slice(0, kept)
      .map((t) => t.text)
      .join("")
      .trimEnd()}${ellipsis}`;
    if (kept === 0 || weightedLength(out) <= max) {
      return { text: out, truncated: true };
    }
  }
}
