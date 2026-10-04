const encoder = new TextEncoder();

/**
 * 文字列を定数時間で比較する。
 * 長さの違いは早期に返すが、内容の比較は一致位置に依存しない。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
