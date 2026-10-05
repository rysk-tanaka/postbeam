import { describe, expect, test } from "vitest";
import {
  findUrls,
  MAX_WEIGHTED_LENGTH,
  truncateWeighted,
  weightedLength,
} from "../src/weighted-length";

describe("findUrls", () => {
  const urls = (text: string) =>
    findUrls(text).map(({ start, end }) => text.slice(start, end));

  test.each([
    ["(https://example.com)@alice", ["https://example.com"]],
    ["HTTPS://misskey.io/@alice", ["HTTPS://misskey.io/@alice"]],
    [
      "https://en.wikipedia.org/wiki/Foo_(bar)",
      ["https://en.wikipedia.org/wiki/Foo_(bar)"],
    ],
    ["$[tada https://a.com]", ["https://a.com"]],
    ["(see https://a.com/(x)).", ["https://a.com/(x)"]],
    ["見て https://a.com/x. 次", ["https://a.com/x"]],
    ["(https://a.com)https://b.com", ["https://a.com", "https://b.com"]],
    [
      "見て https://misskey.io/notes/abc。@alice",
      ["https://misskey.io/notes/abc"],
    ],
    ["https://example.comです", ["https://example.com"]],
    ["https://a.com:8080/x?q=1#f", ["https://a.com:8080/x?q=1#f"]],
    ["http://localhost:3000/x", []],
    ["https://example.invalid/x", []],
    ["https://my_site.example.com/x", ["https://my_site.example.com/x"]],
    ["https://example.co.jp/x", ["https://example.co.jp/x"]],
    ["https://example.community/x", []],
    ["https://example.com/article(@alice", ["https://example.com/article"]],
    ["https://example.com/x(@alice]", ["https://example.com/x"]],
    ["https://example.com/a~", ["https://example.com/a"]],
    ["https://example.com/a&&&", ["https://example.com/a"]],
    ["https://a.com/[x]", ["https://a.com/"]],
    ["https://sushi.ski/@alice", ["https://sushi.ski/@alice"]],
    ["https://a.com/x×y", ["https://a.com/x"]],
    ["https://a.com/?q=é", ["https://a.com/?q="]],
    ["https://a.com#frag", ["https://a.com"]],
    ["nicehttps://a.com/x", []],
    ["#https://a.com/x", []],
    ["https://example-.com/@alice", []],
    ["https://-example.com/x", []],
    ["https://a_.example.com/x", []],
    ["＠https://a.com/x", []],
  ])("%s", (text, expected) => {
    expect(urls(text)).toEqual(expected);
  });
});

describe("weightedLength", () => {
  test("ASCII は 1 文字 1", () => {
    expect(weightedLength("hello")).toBe(5);
  });

  test("日本語は 1 文字 2（Buffer の残り 270 表示と一致）", () => {
    expect(weightedLength("てすとなう")).toBe(10);
    expect(MAX_WEIGHTED_LENGTH - weightedLength("てすとなう")).toBe(270);
  });

  test("URL は長さに関係なく 23", () => {
    expect(weightedLength("https://example.com/a/very/long/path?q=1")).toBe(23);
    expect(weightedLength("見て https://example.com")).toBe(4 + 1 + 23);
  });

  test("絵文字は ZWJ 結合でも 1 書記素 2", () => {
    expect(weightedLength("👍")).toBe(2);
    expect(weightedLength("👨‍👩‍👧")).toBe(2);
  });

  test("URL の直後に続く日本語は URL に含めずに数える", () => {
    expect(
      weightedLength("詳細はhttps://example.com/news/123を見てください。"),
    ).toBe(6 + 23 + 16);
  });

  test("大文字のスキームも URL として数える", () => {
    expect(weightedLength("Https://example.com/news/123")).toBe(23);
  });

  test("句読点が長く続く URL でも時間がかからない", () => {
    // 修正前の正規表現では長さの二乗で遅くなり、この長さでは 1 秒を超えていた
    const text = `https://a.com/x${"!".repeat(30000)}w`;
    const started = performance.now();
    expect(findUrls(text)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("findUrls が拾わない URL も 23 より少なく数えない", () => {
    // https:// を 23、残りを文字として数える
    expect(weightedLength("https://例.jp")).toBe(23 + 2 + 3);
    expect(weightedLength(`${"あ".repeat(130)} https://例.jp`)).toBe(
      260 + 1 + 28,
    );
  });

  test("findUrls が拾わない URL の直後の日本語は、URL と別に数えて切り詰める", () => {
    const text = `https://foo.zzz/notes/abc${"あ".repeat(200)}`;
    const r = truncateWeighted(text);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("https://foo.zzz/notes/abcあ")).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test("@ の直後のドメイン（リモートのメンション）は URL として数えない", () => {
    expect(weightedLength("@alice@misskey.io")).toBe(17);
  });

  test("一覧にない TLD の URL は、ドメインを多めに数える", () => {
    // X はリンクにしないので全長で数えるが、少なく数えないことだけを保証する
    const text = "https://example.invalid/x";
    expect(weightedLength(text)).toBeGreaterThanOrEqual(text.length);
  });

  test("URL 末尾の句読点は URL に含めずに数える", () => {
    expect(weightedLength("見て https://a.com.")).toBe(4 + 1 + 23 + 1);
  });

  test("プロトコルなしのドメインは長さと 23 の大きいほう", () => {
    expect(weightedLength("misskey.io")).toBe(23);
    expect(weightedLength("見て misskey.io")).toBe(4 + 1 + 23);
    const longDomain = "a-very-long-subdomain.example.com";
    expect(weightedLength(longDomain)).toBe(longDomain.length);
  });

  test("数字だけの並びはドメインとみなさない", () => {
    expect(weightedLength("1.5")).toBe(3);
    expect(weightedLength("v1.2.3")).toBe(6);
  });

  test("一般句読点の一部（ダッシュ・引用符）は 1", () => {
    expect(weightedLength("—“”")).toBe(3);
  });
});

describe("truncateWeighted", () => {
  test("上限以内ならそのまま", () => {
    expect(truncateWeighted("短い文")).toEqual({
      text: "短い文",
      truncated: false,
    });
  });

  test("上限を超えたら … を付けて 280 以内に収める", () => {
    const long = "あ".repeat(200);
    const r = truncateWeighted(long);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("…")).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test("ドメインは途中で切らずにまるごと落とす", () => {
    const text = `${"a".repeat(260)} misskey.io`;
    const r = truncateWeighted(text);
    expect(r.text).not.toContain("miss");
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test("URL は途中で切らずにまるごと落とす", () => {
    const text = `${"a".repeat(270)} https://example.com/page`;
    const r = truncateWeighted(text);
    expect(r.text).not.toContain("https://");
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });
});
