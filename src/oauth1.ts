/**
 * OAuth 1.0a（HMAC-SHA1）の Authorization ヘッダを生成する。
 * https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export interface SignOptions {
  method: string;
  url: string;
  /** クエリ文字列やフォーム形式の本文のパラメータ（JSON 本文は署名に含めない） */
  params?: Record<string, string>;
  /** テスト用。省略時はランダム値と現在時刻 */
  nonce?: string;
  timestamp?: number;
}

/** RFC 3986 のパーセントエンコード */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

export async function hmacSha1Base64(
  key: string,
  data: string,
): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  return toBase64(
    await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data)),
  );
}

export function signatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const normalized = Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) =>
      ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(normalized),
  ].join("&");
}

export async function signOAuth1(
  creds: OAuth1Credentials,
  opts: SignOptions,
): Promise<{ header: string; signature: string }> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: opts.nonce ?? randomNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(opts.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const base = signatureBaseString(opts.method, opts.url, {
    ...(opts.params ?? {}),
    ...oauth,
  });
  const key = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;
  const signature = await hmacSha1Base64(key, base);
  const header = `OAuth ${Object.entries({
    ...oauth,
    oauth_signature: signature,
  })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ")}`;
  return { header, signature };
}
