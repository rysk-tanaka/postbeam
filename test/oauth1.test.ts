import { describe, expect, test } from "vitest";
import { percentEncode, signatureBaseString, signOAuth1 } from "../src/oauth1";

// X 公式ドキュメント「Creating a signature」の例
// https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature
const creds = {
  consumerKey: "xvz1evFS4wEEPTGEFPHBog",
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
  tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
};
const opts = {
  method: "POST",
  url: "https://api.twitter.com/1.1/statuses/update.json",
  params: {
    status: "Hello Ladies + Gentlemen, a signed OAuth request!",
    include_entities: "true",
  },
  nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
  timestamp: 1318622958,
};

describe("OAuth 1.0a", () => {
  test("RFC 3986 でエンコードする", () => {
    expect(percentEncode("Ladies + Gentlemen!*")).toBe(
      "Ladies%20%2B%20Gentlemen%21%2A",
    );
  });

  test("署名ベース文字列が公式の例と一致する", () => {
    const base = signatureBaseString(opts.method, opts.url, {
      ...opts.params,
      oauth_consumer_key: creds.consumerKey,
      oauth_nonce: opts.nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(opts.timestamp),
      oauth_token: creds.token,
      oauth_version: "1.0",
    });
    expect(base).toBe(
      "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
  });

  test("署名が公式の例と一致する", async () => {
    const { signature, header } = await signOAuth1(creds, opts);
    expect(signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
    expect(header).toContain(
      'oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"',
    );
    expect(header.startsWith("OAuth ")).toBe(true);
  });
});
