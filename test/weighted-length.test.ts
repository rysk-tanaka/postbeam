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
    ["https://a.com/[x]", ["https://a.com/[x"]],
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
    // X はクエリの末尾の + や ) を URL に含めない。パスの末尾の + は含める
    ["https://example.com/search?q=c++", ["https://example.com/search?q=c"]],
    ["https://example.com/path?a=b+", ["https://example.com/path?a=b"]],
    ["https://example.com/path?+", ["https://example.com/path"]],
    ["https://example.com/path+", ["https://example.com/path+"]],
    ["https://example.com/?q=(a)", ["https://example.com/?q=(a"]],
    // X はクエリでは括弧の対応を見ない
    ["https://ex.com/a?q=x)@alice", ["https://ex.com/a?q=x)@alice"]],
    // パスに ? は含まれないので、括弧の中の ? の手前で括弧は閉じられていない
    ["https://ex.com/x(a?b)@alice", ["https://ex.com/x"]],
    ["https://example.com/?a=1&", ["https://example.com/?a=1&"]],
    // X はパスの末尾に置けない文字の直後の ? をクエリの始まりとみなさない
    ["https://ex.com/a.?x=@user", ["https://ex.com/a"]],
    ["https://ex.com/a!?x=1&y=2", ["https://ex.com/a"]],
    ["https://ex.com/a/?x=1", ["https://ex.com/a/?x=1"]],
    // ? の直前はクエリではなくパスの末尾の規則で判定する（& は置けず、+ と ) は置ける）
    ["https://ex.com/a&?x=1", ["https://ex.com/a"]],
    ["https://ex.com/a+?x=1", ["https://ex.com/a+?x=1"]],
    ["https://ex.com/(a)?x=1", ["https://ex.com/(a)?x=1"]],
    // クエリの末尾の句読点は URL に含めない
    ["https://example.com/?q=a.", ["https://example.com/?q=a"]],
    ["https://example.com/?q=a!", ["https://example.com/?q=a"]],
    // X は中身のない括弧を URL に含めない
    ["https://ex.com/()u", ["https://ex.com/"]],
    ["https://ex.com/a()b", ["https://ex.com/a"]],
    // 中身のない角括弧は URL に含める
    [
      "https://ex.com/search?tags[]=alpha&tags[]=beta&page=2",
      ["https://ex.com/search?tags[]=alpha&tags[]=beta&page=2"],
    ],
    ["https://ex.com/a[]b", ["https://ex.com/a[]b"]],
    // X は角括弧の対応を見ないので、] がクエリにあっても [ で打ち切らない
    ["https://ex.com/a[b?c]@alice", ["https://ex.com/a[b?c]@alice"]],
    ["https://ex.com/a]b", ["https://ex.com/a]b"]],
    // X は末尾の丸括弧を、直前がパスの末尾に置ける文字のときだけ URL に含める
    ["https://ex.com/a](@alice)", ["https://ex.com/a"]],
    ["https://ex.com/a.(@alice)", ["https://ex.com/a"]],
    ["https://ex.com/page,(@alice)", ["https://ex.com/page"]],
    ["https://ex.com/a~(@alice)", ["https://ex.com/a"]],
    ["https://ex.com/a.(b)(c)", ["https://ex.com/a"]],
    ["https://ex.com/a.(b)?x=@alice", ["https://ex.com/a"]],
    ["https://ex.com/a(b)(c)", ["https://ex.com/a(b)(c)"]],
    ["https://ex.com/wiki/Foo_(bar)", ["https://ex.com/wiki/Foo_(bar)"]],
    // X は TLD の直後が @ や + のホストを URL にしない
    ["https://example.com@x", []],
    ["https://example.com+", []],
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

  test("RGI の絵文字は ZWJ 結合でも 1 書記素 2", () => {
    expect(weightedLength("👍")).toBe(2);
    expect(weightedLength("👨‍👩‍👧")).toBe(2);
  });

  // 期待値は twitter-text 3.1.0 の parseTweet と同じか、それより多い値
  test.each([
    ["❤️", 2],
    ["👍🏻", 2],
    ["👨‍👩‍👧", 2],
    // 標準の絵文字にない単純な並びは、X と同じく文字ごとの重みの合計
    ["❤︎", 4],
    ["☺︎", 4],
    ["😀🏻", 4],
    ["🐱‍👤", 5],
    // X は 1 だが、少なく数えないよう 2 と多めに数える
    ["©", 2],
    // 旗は 2 に縮めない。🇨🇶 は X でも 4
    ["🇨🇶", 4],
    ["🇯🇵", 4],
  ])("絵文字 %s は %i", (text, expected) => {
    expect(weightedLength(text)).toBe(expected);
  });

  test("クエリの末尾の + は URL に含めずに数える", () => {
    expect(weightedLength("https://example.com/search?q=c++")).toBe(23 + 2);
  });

  test("パスの末尾に置けない文字の直後のクエリは、URL に含めずに数える", () => {
    expect(weightedLength("https://ex.com/a.?x=@user")).toBeGreaterThanOrEqual(
      32,
    );
  });

  test("TLD の直後に @ が続くホストは、URL として短く数えない", () => {
    const text = `https://${"a".repeat(60)}.com@`;
    expect(weightedLength(text)).toBeGreaterThanOrEqual(73);
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

  // twitter-text 3.1.0 では 43 と 40 で、後ろのドメインだけを URL として数える。
  // ここでは中のドメインをすべて 23 以上として数えるので、それより少なくならない
  test.each([
    ["https://example.com+misskey.io", 43],
    ["https://x.jp@#:*~a.co", 40],
  ])("findUrls が拾わない %s も、中のドメインを少なく数えない", (text, x) => {
    expect(weightedLength(text)).toBeGreaterThanOrEqual(x);
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

  test("標準の絵文字にない並びも X と同じく数えて、280 以内に収める", () => {
    // 1 書記素 2 と数えると 280 で切り詰めないが、X では 300
    const text = "あ".repeat(130) + "❤︎".repeat(10);
    const r = truncateWeighted(text);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(`${"あ".repeat(130)}${"❤︎".repeat(4)}…`);
    expect(weightedLength(r.text)).toBe(278);
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
