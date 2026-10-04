/**
 * X の文字数カウント（twitter-text v3 の重み付けルールの簡易実装）。
 *
 * - 以下のコードポイント範囲は 1、それ以外（日本語など）は 2 として数える
 * - 絵文字は 1 書記素あたり 2
 * - URL は長さに関係なく 23
 */
export const MAX_WEIGHTED_LENGTH = 280;
export const URL_WEIGHT = 23;

const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

const URL_PATTERN = /https?:\/\/[^\s<>"'）」』】]+/gu;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

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

interface Token {
  text: string;
  weight: number;
}

/** URL を 1 つのかたまりとして扱いながら、書記素単位に分割する */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pushPlain = (s: string) => {
    for (const { segment } of segmenter.segment(s)) {
      tokens.push({ text: segment, weight: graphemeWeight(segment) });
    }
  };
  let last = 0;
  for (const m of text.matchAll(URL_PATTERN)) {
    const start = m.index ?? 0;
    pushPlain(text.slice(last, start));
    tokens.push({ text: m[0], weight: URL_WEIGHT });
    last = start + m[0].length;
  }
  pushPlain(text.slice(last));
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
 * URL は途中で切らず、入りきらなければまるごと落とす。
 */
export function truncateWeighted(
  text: string,
  max: number = MAX_WEIGHTED_LENGTH,
  ellipsis = "…",
): TruncateResult {
  const normalized = text.normalize("NFC");
  if (weightedLength(normalized) <= max) {
    return { text: normalized, truncated: false };
  }
  const budget = max - weightedLength(ellipsis);
  let used = 0;
  let out = "";
  for (const token of tokenize(normalized)) {
    if (used + token.weight > budget) break;
    out += token.text;
    used += token.weight;
  }
  return { text: out.trimEnd() + ellipsis, truncated: true };
}
