/**
 * X の文字数カウント（twitter-text v3 の重み付けルールの簡易実装）。
 *
 * - 以下のコードポイント範囲は 1、それ以外（日本語など）は 2 として数える
 * - 絵文字を含む書記素は、標準の絵文字（RGI）の並びなら 2。それ以外（`❤︎` のような
 *   テキスト表示の記号や、標準にない ZWJ・肌色の組み合わせ）は、文字ごとの重みの合計で
 *   数え、最低 2 とする。`❤︎` や `🐱‍👤` のような単純な並びでは X と同じ値になる。
 *   X は表にある部分列を 2 と数え、`©` を 1 と数えるので、こちらのほうが多くなることがある。
 *   `🇯🇵` のような地域指示子の旗とキーキャップは文字ごとの合計で、X より多めになる
 * - twitter-text の絵文字の表（twemoji-parser 11）にない並びは、twitter-text 3.1.0 では
 *   文字ごとに数えられるが、ここでは RGI として 2 と数える。`🫃🏻` や `🐦‍🔥` のような新しい
 *   並びのほか、`⚧️`、`🤝🏻`、`🫶🏻` や、表に異体字セレクター付きの形がない `♾️` のように、
 *   よく使う絵文字も当たる。`🧑‍💻`、`❤️‍🔥`、`👁️‍🗨️` のような ZWJ の並びも当たる。
 *   X は 4〜9 と数える（`♾️` と `🤝🏻` は 4、`🧑‍💻` は 5、`🫱🏻‍🫲🏼` は 9）。
 *   多めに数える方針の例外で、X が古い表を使っていれば少なく数えて上限を超えうる。
 *   X のサーバーがどの表を使っているかは確かめられず、よく使う絵文字を一律に多めに数えると
 *   切り詰めが早まりすぎるため、RGI の並びは一律 2 と数える
 * - URL は長さに関係なく 23。URL とみなす範囲は scanUrls（ScanMatch の xUrl）を参照。
 *   findUrls の範囲（狭い側）は使わない。
 *   X は走査のかたまり（scanUrls を参照）の中にだけ URL を見つけるので、かたまりの外は
 *   文字として数える。findUrls が URL にしないプロトコル付きのかたまり（国際化ドメインなど）も、
 *   X が URL とみなせば 23、みなさなければ文字ごとの重みで数える。`xn--` で始まり英数字・`-`・`.`
 *   以外を含むホストは、X が URL とみなすかを確かめないので、その大きいほう
 * - プロトコルのないかたまりの、ドメインの部分の中のドメイン（`misskey.io`）は、長さと 23 の
 *   大きいほう。直前の文字は走査で確かめるが、`-`・`_`・`.`・`/` の直後の URL を
 *   X が捨てる規則までは確かめないので、URL とみなす場合の 23 と、みなさない場合の長さの
 *   大きいほうで多めに見積もる
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
  `(?::[0-9]+)?(/${PATH_SEGMENT}*)?(?:\\?${QUERY_CHAR}*${QUERY_ENDING_CHAR})?`,
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
// X は xn-- で始まるドメインを、validAsciiDomain のドメイン（ラベルは英数字・アクセント付きの
// 文字・-）を含まなければ URL にしない
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
// twitter-text が使う punycode.js 1.4.1 の toASCII は、これらの区切りも . にしてから変換し、
// 印字できる ASCII 以外の文字を含む部分を Punycode にする
const IDNA_SEPARATOR_PATTERN = /[\u3002\uFF0E\uFF61]/;
const PUNYCODE_TARGET_PATTERN = /[^\x20-\x7E]/;
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
// プロトコルのないドメインの、TLD の手前までのラベルの並び（bareDomains を参照）。
// X の validAsciiDomain は、名前に反してラベルにアクセント付きの文字を許す（`café.com` は 23）。
// ラベルの文字の直後からは読み始めない。並びの途中から読めるドメインは手前からも読めるので、
// X も途中からは始めない。途中から試すと、. のない長い並びで位置ごとに終わりまで読み直し、
// 長さの二乗の時間がかかる。
const BARE_LABEL_CHAR = `a-z0-9${LATIN_ACCENT_CHARS}`;
const BARE_DOMAIN_LABELS_PATTERN = new RegExp(
  `(?<![${BARE_LABEL_CHAR}-])(?:[${BARE_LABEL_CHAR}-]+\\.)+`,
  "giu",
);
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
// 2 つ並んだとき、その間が必ず書記素の境界になる文字（印字できる ASCII、和文の約物、かな、
// CJK 統合漢字、ハングルの音節、全角英数と半角カナ）。
// 後ろに結合文字が来れば書記素になるので、片方だけでは境界と決められない。
// 結合文字（声調記号の U+302A〜302F、濁点の U+3099・U+309A、半角の濁点の U+FF9E・U+FF9F）は除く
const STANDALONE_CHAR_PATTERN =
  /[\x20-\x7E\u3000-\u3029\u3030-\u3096\u309B-\u30FF\u4E00-\u9FFF\uAC00-\uD7A3\uFF01-\uFF9D]/;

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export interface UrlMatch {
  start: number;
  end: number;
}

/**
 * X がプロトコル付きの URL として認める長さを返す。認めなければ undefined。
 * match は走査でマッチした URL の部分、host はそのドメイン。
 * isOpaquePunycodeHost のホストは、validAsciiDomain のドメインを含むかは確かめずに、
 * ラベルと URL の長さだけを確かめて長さを返す
 */
function xUrlLength(
  match: string,
  protocol: string,
  host: string,
): number | undefined {
  if (!hasValidIdnaLabels(host)) return undefined;
  // X は長さの上限を、t.co の URL を縮める前に確かめる
  if (protocol.length + match.length > MAX_URL_LENGTH) return undefined;
  const tco = TCO_URL_PATTERN.exec(match);
  if (!tco) return match.length;
  const slug = tco[1] ?? "";
  return slug.length > MAX_TCO_SLUG_LENGTH ? undefined : tco[0].length;
}

/**
 * xn-- で始まり、英数字・-・. 以外を含むホスト。X は validAsciiDomain のドメインを含むかで
 * URL にするかを決めるが、ここでは確かめない。英数字と - と . だけのホストは、それ自体が
 * validAsciiDomain のドメインになる
 */
function isOpaquePunycodeHost(host: string): boolean {
  return (
    host.startsWith(PUNYCODE_HOST_PREFIX) &&
    NON_ASCII_DOMAIN_CHAR_PATTERN.test(host)
  );
}

/**
 * X（twitter-text の idna.toAscii）が、ホストを Punycode に変換したラベルの長さを認めるか。
 * X はラベルが空か 63 文字を超えるホストを URL にしない。toAscii は変換前のホストを返すので、
 * URL の長さの上限は変換前の長さで確かめる
 */
function hasValidIdnaLabels(host: string): boolean {
  for (const label of host.split(".")) {
    const parts = label.split(IDNA_SEPARATOR_PATTERN);
    let labelLength = parts.length - 1;
    for (const part of parts) {
      if (!PUNYCODE_TARGET_PATTERN.test(part)) {
        labelLength += part.length;
        continue;
      }
      // 変換すると文字ごとに 1 文字以上になるので、文字数で超えていれば変換しない
      const codePointCount = Array.from(part).length;
      if (codePointCount > MAX_LABEL_LENGTH) return false;
      labelLength += PUNYCODE_HOST_PREFIX.length + punycodeLength(part);
    }
    if (labelLength < 1 || labelLength > MAX_LABEL_LENGTH) return false;
  }
  return true;
}

const PUNYCODE_BASE = 36;
const PUNYCODE_T_MIN = 1;
const PUNYCODE_T_MAX = 26;

/** punycode.js 1.4.1 の encode（RFC 3492）が返す文字列の長さ */
function punycodeLength(input: string): number {
  const codePoints = Array.from(input, (c) => c.codePointAt(0) ?? 0);
  const basicLength = codePoints.filter((cp) => cp < 0x80).length;
  let length = basicLength + (basicLength > 0 ? 1 : 0);
  let handled = basicLength;
  let n = 0x80;
  let delta = 0;
  let bias = 72;
  while (handled < codePoints.length) {
    const m = Math.min(...codePoints.filter((cp) => cp >= n));
    delta += (m - n) * (handled + 1);
    n = m;
    for (const cp of codePoints) {
      if (cp < n) delta++;
      if (cp !== n) continue;
      // delta を可変長の整数として書く桁数
      for (let q = delta, k = PUNYCODE_BASE; ; k += PUNYCODE_BASE) {
        const t = Math.min(Math.max(k - bias, PUNYCODE_T_MIN), PUNYCODE_T_MAX);
        length++;
        if (q < t) break;
        q = Math.floor((q - t) / (PUNYCODE_BASE - t));
      }
      bias = adaptPunycodeBias(delta, handled + 1, handled === basicLength);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return length;
}

function adaptPunycodeBias(
  delta: number,
  numPoints: number,
  isFirstTime: boolean,
): number {
  const baseMinusTMin = PUNYCODE_BASE - PUNYCODE_T_MIN;
  let d = isFirstTime ? Math.floor(delta / 700) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  for (; d > (baseMinusTMin * PUNYCODE_T_MAX) >> 1; k += PUNYCODE_BASE) {
    d = Math.floor(d / baseMinusTMin);
  }
  return Math.floor(k + ((baseMinusTMin + 1) * d) / (d + 38));
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

/**
 * 走査の 1 回のマッチ。X が URL とみなす範囲（xUrl）と、findUrls が URL とみなす範囲（url）を
 * 分けて持つ
 */
interface ScanMatch {
  start: number;
  /** ドメインの部分の始まり。プロトコルがあればその直後で、start より後ろになる */
  hostStart: number;
  /** ドメインの部分の終わり。その後ろはポート・パス・クエリ */
  hostEnd: number;
  /** 走査が消費した範囲の終わり。X は次の URL をここから探す */
  consumedEnd: number;
  /** ポートの後ろに / で始まるパスがある。X はプロトコルのないドメインを、パスがあれば伸ばす */
  hasPath: boolean;
  /** X が URL とみなす範囲（t.co の URL は縮めた後）。プロトコル付きのときだけ */
  xUrl?: UrlMatch;
  /**
   * ホストが isOpaquePunycodeHost に当たる。xUrl があっても、X が URL とみなすかは
   * 確かめていない
   */
  hasOpaqueHost?: boolean;
  /**
   * findUrls が URL とみなす範囲。xUrl のうち、ホストが ASCII で hasOpaqueHost でないもの
   * （狭い側）
   */
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
  const hasPath = URL_REST_PATTERN.exec(text)?.[1] !== undefined;
  const consumedEnd = URL_REST_PATTERN.lastIndex;
  // プロトコルのないドメインは URL として返さず、文字数の側で多めに数える
  if (!protocol) return { start, hostStart, hostEnd, consumedEnd, hasPath };
  const match = text.slice(start, consumedEnd);
  const host = text.slice(hostStart, hostEnd);
  const length = xUrlLength(match, protocol, host);
  const xUrl =
    length === undefined ? undefined : { start, end: start + length };
  const hasOpaqueHost = isOpaquePunycodeHost(host);
  // 日本語などを含むドメインも X は URL にするが、メンションの無害化を広く取らないよう、
  // 一律に URL にしない。xn-- で始まるホストも、validAsciiDomain のドメインを含むかを確かめずに
  // URL にしない（狭い側）
  const isNarrowHost = !PUNYCODE_TARGET_PATTERN.test(host) && !hasOpaqueHost;
  const url = isNarrowHost ? xUrl : undefined;
  return {
    start,
    hostStart,
    hostEnd,
    consumedEnd,
    hasPath,
    xUrl,
    hasOpaqueHost,
    url,
  };
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
  for (const { start, hostStart, consumedEnd } of scanUrls(text)) {
    if (hostStart > start) chunks.push({ start, end: consumedEnd });
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

function codePointsWeight(g: string): number {
  let w = 0;
  for (const ch of g) w += codePointWeight(ch.codePointAt(0) ?? 0);
  return w;
}

let rgiEmojiPattern: RegExp | undefined;

/** RGI の絵文字の並びか。正規表現の構築に数 ms かかるので、初めて使うときに作る */
function isRgiEmoji(g: string): boolean {
  // biome-ignore lint/complexity/useRegexLiterals: TS は target が ES2024 より前だと v フラグのリテラルをエラーにする
  rgiEmojiPattern ??= new RegExp("^\\p{RGI_Emoji}$", "v");
  return rgiEmojiPattern.test(g);
}

function graphemeWeight(g: string): number {
  // 旗（地域指示子）やキーキャップは絵文字の記号を含まないので、文字ごとの合計のまま多めに数える
  if (!EMOJI_PATTERN.test(g)) return codePointsWeight(g);
  // 1 文字なら、RGI かどうかによらず 2。X は © などを 1 と数えるが、少なく数えないよう 2 と数える
  const isSingleCodePoint =
    g.length === 1 || (g.length === 2 && (g.codePointAt(0) ?? 0) > 0xffff);
  if (isSingleCodePoint || isRgiEmoji(g)) return 2;
  return Math.max(codePointsWeight(g), 2);
}

/** 書記素の重みと、文字ごとの重みの合計の大きいほう */
function graphemeOrCodePointsWeight(g: string): number {
  return Math.max(codePointsWeight(g), graphemeWeight(g));
}

function plainWeight(s: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(s)) w += graphemeWeight(segment);
  return w;
}

interface BareDomain {
  index: number;
  text: string;
}

/**
 * text の from から to までの中のプロトコルなしのドメイン。X の validAsciiDomain と同じく、ラベルの並びを貪欲に読んでから、
 * TLD を後ろの . から順に試す（ラベルの文字は BARE_DOMAIN_LABELS_PATTERN を参照）。
 * from には、走査のかたまりの始まり（X がそこから URL を探した位置）を渡す
 */
function bareDomains(text: string, from: number, to: number): BareDomain[] {
  const domains: BareDomain[] = [];
  const pattern = BARE_DOMAIN_LABELS_PATTERN;
  // 範囲だけを切り出して読む。本文の先頭から切り出すと、範囲ごとに本文の長さだけ
  // コピーし、URL が多い本文で長さの二乗の時間がかかる。X は from から URL を探すので、
  // 切り出した先頭では後読みが効かず、直前の文字によらず from から読み始める
  const range = text.slice(from, to);
  pattern.lastIndex = 0;
  for (let m = pattern.exec(range); m !== null; m = pattern.exec(range)) {
    const labels = m[0];
    const index = from + m.index;
    const end = bareDomainEnd(text, index, labels, to);
    if (end === undefined) continue;
    domains.push({ index, text: text.slice(index, end) });
    pattern.lastIndex = end - from;
  }
  return domains;
}

/**
 * index から始まるラベルの並び labels の後ろの TLD を、後ろの . から順に試し、ドメインの終わりを返す。
 * to までに TLD がなければ undefined
 */
function bareDomainEnd(
  text: string,
  index: number,
  labels: string,
  to: number,
): number | undefined {
  for (
    let dot = labels.length - 1;
    dot >= 0;
    dot = labels.lastIndexOf(".", dot - 1)
  ) {
    const tldStart = index + dot + 1;
    const end = tldStart + tldLengthAt(text, tldStart);
    if (end !== tldStart && end <= to) return end;
    if (dot === 0) break;
  }
  return undefined;
}

interface Token {
  text: string;
  weight: number;
}

function pushPlainTokens(tokens: Token[], s: string): void {
  // 走査のかたまりごとに呼ぶので、空の文字列では書記素の分割を省く
  if (s === "") return;
  for (const { segment } of segmenter.segment(s)) {
    tokens.push({ text: segment, weight: graphemeWeight(segment) });
  }
}

/**
 * X が URL とみなすかを確かめない s の、1 つのトークン。URL とみなす場合の 23 と、
 * みなさない場合の文字ごとの重みの大きいほうで数える
 */
function possibleUrlToken(s: string): Token {
  return { text: s, weight: Math.max(plainWeight(s), URL_WEIGHT) };
}

/**
 * text の start から end までを、domains（その範囲の bareDomains）を 1 つずつのトークンとして、
 * 書記素単位に分割する。ドメインは、X が URL とみなせば 23、みなさなければ文字ごとの重み
 * （`みんな` などの TLD は 1 文字 2）なので、その大きいほうで数える。
 * isExtended（X が最後のドメインをパスまで伸ばす）なら、最後のドメインより後ろの書記素を
 * 文字ごとの合計以上で数え、最後のドメインと 1 つのトークンにまとめる。
 * 切り詰めでパスの途中を切ると、X が短いパスへのリンクにしてリンク先が変わるため
 */
function pushDomainTokens(
  tokens: Token[],
  text: string,
  start: number,
  end: number,
  domains: readonly BareDomain[],
  isExtended: boolean,
): void {
  let last = start;
  for (const domain of domains) {
    pushPlainTokens(tokens, text.slice(last, domain.index));
    tokens.push(possibleUrlToken(domain.text));
    last = domain.index + domain.text.length;
  }
  const extendedUrl = isExtended ? tokens.at(-1) : undefined;
  if (extendedUrl === undefined) {
    pushPlainTokens(tokens, text.slice(last, end));
    return;
  }
  const path = text.slice(last, end);
  extendedUrl.text += path;
  for (const { segment } of segmenter.segment(path)) {
    extendedUrl.weight += graphemeOrCodePointsWeight(segment);
  }
}

/**
 * プロトコル付きのかたまり。X が URL とみなす範囲は、23 の 1 つのトークンにする。
 * 国際化ドメインの URL を途中で切ると、切り詰めでリンク先が変わるため。
 * 残り（t.co の URL を縮めた残り）と、X が URL とみなさないかたまりは、文字として
 * 書記素単位に分ける
 */
function pushProtocolChunkTokens(
  tokens: Token[],
  text: string,
  scan: ScanMatch,
): void {
  const { xUrl } = scan;
  if (xUrl === undefined) {
    pushPlainTokens(tokens, text.slice(scan.start, scan.consumedEnd));
    return;
  }
  // X が URL とみなすかを確かめないので、みなす場合とみなさない場合の大きいほうで数える
  if (scan.hasOpaqueHost) {
    tokens.push(possibleUrlToken(text.slice(scan.start, scan.consumedEnd)));
    return;
  }
  tokens.push({ text: text.slice(scan.start, xUrl.end), weight: URL_WEIGHT });
  pushPlainTokens(tokens, text.slice(xUrl.end, scan.consumedEnd));
}

/**
 * URL とドメインを 1 つのかたまりとして扱いながら、書記素単位に分割する。
 * X は走査のかたまりの中にだけ URL を見つけるので、かたまりの外は文字として数える
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const isBoundary = createBoundaryChecker(text);
  let last = 0;
  for (const scan of scanUrls(text)) {
    const { start, hostStart, hostEnd, consumedEnd } = scan;
    const hasProtocol = hostStart > start;
    // 走査は直前の 1 文字を UTF-16 の単位で消費するので、絵文字の下位サロゲートや異体字
    // セレクター（`❤️` の U+FE0F）からプロトコルのないかたまりを読むことがある。書記素を
    // 割って別々に数えないよう、かたまりを含む書記素の始まりから数える
    let cut = start;
    if (!hasProtocol) {
      while (cut > last && !isBoundary(cut)) cut--;
    }
    pushPlainTokens(tokens, text.slice(last, cut));
    last = consumedEnd;
    if (hasProtocol) {
      pushProtocolChunkTokens(tokens, text, scan);
      continue;
    }
    // プロトコルのないかたまり。X はドメインの部分の中の validAsciiDomain のドメインを URL にし、
    // パスがあれば最後のドメインをかたまりの終わりまで伸ばす。ポート・パス・クエリは
    // 文字として数えても、X より少なくはならない。
    // ただし X は、伸ばした URL の文字列（`a.com/x`）の長さだけ読み飛ばしてから続きを数える。
    // 最後のドメインとパスの間に日本語などがあると、途中から数え始め、割れた絵文字の並びを
    // 文字ごとに数える（`a.com👨‍👩‍👧あ.jp/x` は 36）。そのときは、最後のドメインより後ろの
    // 書記素を文字ごとの合計以上で数える（pushDomainTokens を参照）
    // ドメインは X と同じく走査の始まりから探す。戻した分も含めると、`\u0301\u0301a.com` の
    // 1 つ目の結合文字（X は直前の文字として消費する）までドメインとして数えてしまう
    const domains = bareDomains(text, start, hostEnd);
    const isExtended = domains.length > 0 && scan.hasPath;
    pushDomainTokens(tokens, text, cut, consumedEnd, domains, isExtended);
  }
  pushPlainTokens(tokens, text.slice(last));
  return mergeSplitGraphemes(tokens, isBoundary);
}

/**
 * text の位置が書記素の境界かを返す関数を作る。本文全体を書記素に分けて境界を集めると、
 * トークンを作るときの分割と合わせて 2 回分けることになるため、位置ごとに確かめる
 */
function createBoundaryChecker(text: string): (index: number) => boolean {
  const segments = segmenter.segment(text);
  return (index) => {
    if (index === 0 || index >= text.length) return true;
    // 日本語や ASCII の本文では、境界の判定を省く
    const isKnownBoundary =
      STANDALONE_CHAR_PATTERN.test(text[index - 1] ?? "") &&
      STANDALONE_CHAR_PATTERN.test(text[index] ?? "");
    return isKnownBoundary || segments.containing(index)?.index === index;
  };
}

/**
 * 書記素の途中で分かれたトークンを 1 つにまとめる。走査は UTF-16 の単位で区切るので、
 * パスの終わり（`#️⃣` の `#`）などでも書記素を割ることがある。切り詰めで書記素を
 * 割らないため
 */
function mergeSplitGraphemes(
  tokens: readonly Token[],
  isBoundary: (index: number) => boolean,
): Token[] {
  const merged: Token[] = [];
  let offset = 0;
  for (const token of tokens) {
    const prev = merged.at(-1);
    if (prev !== undefined && !isBoundary(offset)) {
      prev.text += token.text;
      prev.weight += token.weight;
    } else {
      merged.push({ ...token });
    }
    offset += token.text.length;
  }
  return merged;
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
