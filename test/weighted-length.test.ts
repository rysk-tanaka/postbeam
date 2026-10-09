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
    // TLD は X の一覧で判定する
    ["https://example.community/x", ["https://example.community/x"]],
    ["https://example.zz/x", []],
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
    ["https://ex.com+x", []],
    [`https://${"a".repeat(30)}.com@alice`, []],
    // X は TLD に当たる位置でホストを終えるので、続く .net@ は URL に含めない
    ["https://a.com.net@x", ["https://a.com"]],
    // X は対応の取れた丸括弧の中に、もう 1 組までしか括弧を含めない
    ["https://a.com/a(b(c(d)))@alice", ["https://a.com/a"]],
    ["https://a.com/x(a(b)(c))@alice", ["https://a.com/x"]],
    ["https://a.com/a((b))", ["https://a.com/a((b))"]],
    // X が URL にしないかたまりは、中の URL も含めて読み飛ばす
    ["$https://misskey.io/?r=https://a.jp/@alice", []],
    ["foohttps://a.com/?u=https://misskey.io/@alice", []],
    ["example.com?u=https://x.com/@bob", []],
    ["/例え.jp/x?u=https://a.com/@bob", []],
    ["\uFEFFhttps://a.com/x", []],
    // X はラベルが 63 文字を超えるホストを URL にしない
    [`https://${"a".repeat(63)}.com/x`, [`https://${"a".repeat(63)}.com/x`]],
    [`https://${"a".repeat(64)}.com/@x`, []],
    // X は t.co の URL をスラッグまでにし、長すぎるスラッグは URL にしない
    ["https://t.co/abc/@alice", ["https://t.co/abc"]],
    [`https://t.co/${"a".repeat(41)}/@alice`, []],
    // パスにはアクセント付きの文字を含める。クエリには含めない
    [
      "https://a.com/é?u=https://b.com/@bob",
      ["https://a.com/é?u=https://b.com/@bob"],
    ],
    ["https://a.com/?q=é/@alice", ["https://a.com/?q="]],
    ["https://a.com/?q=я/@alice", ["https://a.com/?q="]],
    // X は英字の TLD の直後に日本語が続けばドメインを終えるので、後ろの URL も見つける
    [
      "misskey.ioで見てねhttps://misskey.io/@alice",
      ["https://misskey.io/@alice"],
    ],
    [
      "公式はexample.com。詳しくはhttps://example.com/@alice",
      ["https://example.com/@alice"],
    ],
    ["日本x.io日本http://example.com_", ["http://example.com"]],
    // X がホスト全体を確かめて URL にしないものは、先頭部分だけを URL にもしない
    [`https://www.example.com.${"あ".repeat(70)}.com`, []],
    // 一覧にない TLD は X と同じくドメインとして読まないので、X と同じ範囲を消費する
    ["a.zzz/xあ.com/https://e.com/@user", []],
    ["https://a.com.zzz/xx.コム/https://evil.com/@user", ["https://a.com"]],
    ["a.zzz/x:あhttps://e.com/@user", ["https://e.com/@user"]],
    ["a.zzz/x<https://e.com/@user", ["https://e.com/@user"]],
    ["a.zz/xyzあ.com?u=https://b.com/@user", []],
    ["a.zz/b.みんな/https://e.com/@user", []],
    // 小数やファイル名の後ろの URL も見つける
    [
      "1.5倍速で見た。元動画→https://misskey.io/@alice",
      ["https://misskey.io/@alice"],
    ],
    [
      "index.htmlを編集した。https://misskey.io/@alice",
      ["https://misskey.io/@alice"],
    ],
    ["a.みんなhttps://e.com/@user", ["https://e.com/@user"]],
    // X は国際化ドメインも URL にするが、変換後のラベルの長さを確かめないので URL にしない
    ["https://a.vermögensberatung/x", []],
    // X は大文字と小文字を、1 文字ずつ大文字にそろえて比べる（ϵ の大文字は Ε）
    ["/x.ϵλ/https://a.co/@user", []],
    ["https://Misskey.IO/@alice", ["https://Misskey.IO/@alice"]],
    // X は xn-- で始まり、英数字のドメインを含まないホストを URL にしない
    ['https://xn--x.a".com/@user', []],
    ["https://xn--p1ai.com/@alice", ["https://xn--p1ai.com/@alice"]],
    ["https://a.xn--p1ai/@alice", ["https://a.xn--p1ai/@alice"]],
    // TLD の手前のラベルには _ を置けない
    ["https://my_site.com/@alice", []],
    // t.co の URL のクエリと、40 文字までのスラッグ
    ["https://t.co/abc?u=@alice", ["https://t.co/abc?u=@alice"]],
    [
      `https://t.co/${"a".repeat(40)}?u=@alice`,
      [`https://t.co/${"a".repeat(40)}?u=@alice`],
    ],
    // パスとクエリに置ける記号
    ["https://a.com/?q=%E3&u=@alice", ["https://a.com/?q=%E3&u=@alice"]],
    ["https://a.com/~alice/@bob", ["https://a.com/~alice/@bob"]],
    ["https://a.com/a&b/@alice", ["https://a.com/a&b/@alice"]],
    // t.co の URL を縮めても、走査はスラッグの後ろも消費したまま次を探す
    ["https://t.co/abc/:https://misskey.io/@alice", ["https://t.co/abc"]],
    ["＃https://a.com/x", []],
    // X は t.co の大文字と小文字を区別しない
    ["https://T.CO/abc/@alice", ["https://T.CO/abc"]],
    // BOM と同じく、U+FFFE / U+FFFF の直後も URL にしない
    ["\uFFFEhttps://a.com/@bob", []],
    ["\uFFFFhttps://a.com/@bob", []],
    // パスとクエリに置ける記号
    ["https://a.com/a–b/@alice", ["https://a.com/a–b/@alice"]],
    ["https://a.com/a,b;c*d|e/@alice", ["https://a.com/a,b;c*d|e/@alice"]],
    ["https://a.com/x=(@bob)", ["https://a.com/x=(@bob)"]],
    ["https://a.com/a#(@bob)", ["https://a.com/a#(@bob)"]],
    [
      "https://a.com/?a=|b,1*$?&u=@alice",
      ["https://a.com/?a=|b,1*$?&u=@alice"],
    ],
    // Punycode の TLD は、大文字でも当たり、直後の @ を見ない
    ["https://a.XN--P1AI/@alice", ["https://a.XN--P1AI/@alice"]],
    ["https://a.xn--p1ai@x/@bob", ["https://a.xn--p1ai"]],
    // 一方が他方の先頭に当たる TLD は、X と同じく一覧の順（長いほうが先）に試す
    ["https://a.嘉里大酒店/?u=https://b.com/@alice", []],
    ["https://a.भारतम्/?u=https://b.com/@alice", []],
  ])("%s", (text, expected) => {
    expect(urls(text)).toEqual(expected);
  });
});

test("短いドメインが続く長い本文でも時間がかからない", () => {
  // マッチごとにラベルの並びを終わりまで読み直すと、長さの二乗の時間がかかる（数百 ms）
  const text = "_x.jp".repeat(4800);
  const started = performance.now();
  findUrls(text);
  expect(performance.now() - started).toBeLessThan(100);
});

test("X の URL の長さの上限を超える URL は URL にしない", () => {
  // プロトコルの長さと、プロトコルを含む URL の長さの和が 4096 まで
  const longest = `https://a.com/${"a".repeat(4074)}`;
  expect(findUrls(longest)).toEqual([{ start: 0, end: 4088 }]);
  expect(findUrls(`${longest}a`)).toEqual([]);
  expect(findUrls(`${longest}a/@alice`)).toEqual([]);
  // X はホストの先頭部分で終えた URL の長さで確かめる
  expect(findUrls(`https://a.com.zzzz/${"a".repeat(4100)}`)).toEqual([
    { start: 0, end: 13 },
  ]);
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

  test.each([
    // 句読点が続く URL。長さの上限で URL にはならないが、走査の時間を測る
    ["句読点が続く URL", `https://a.com/x${"!".repeat(30000)}w`],
    // 括弧の組が続くパス
    ["括弧の組が続くパス", `https://a.com/${"(aa)".repeat(12000)}(`],
    // 句読点のない日本語。ドメインになりえない位置は試さずに飛ばす
    ["句読点のない日本語", "あ".repeat(30000)],
  ])("%s でも時間がかからない", (_, text) => {
    const started = performance.now();
    findUrls(text);
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

  // twitter-text 3.1.0 の parseTweet の値
  test.each([
    // X は TLD の直後の _ の手前でもドメインを終える
    [`x.https://a.com${"_".repeat(23)}`, 48],
    ["https://a.co_.com8あ", 31],
    ["xn--p1ai.http://1.com_xn--p1ai", 41],
    ["foo.companyfoo.company_foo.companyx.com", 47],
    // X が URL にしないかたまりの中の URL は 23 にしない
    [`a.zzz/xあ.com/https://e.com/${"a".repeat(250)}`, 278],
    // X は TLD の一覧に当たる位置でドメインを終え、残りを文字として数える
    ["misskey.io.backup_2024", 35],
    ["notes.md.bak", 27],
    ["www.example.co.jp+https://misskey.io", 50],
    ["www.example.co.jp1", 27],
    ["a.com.net8", 28],
    // X は ＠・日本語・. の直後のドメインも URL として数える
    ["x＠misskey.io", 26],
    ["＠b.jp", 25],
    ["日本.example.com", 28],
    ["a.みんな", 23],
    ["見てmisskey.io", 27],
    ["詳細はexample.com", 29],
    // TLD の大文字と小文字、Punycode、英字以外の TLD の直後の数字
    ["見てMisskey.IO", 27],
    ["a.РФ", 23],
    ["a.xn--p1ai", 23],
    ["a.ac.コム1", 29],
    ["a.XN--P1AI", 23],
    // X は日本語の直後の、- で始まる最初のラベルからドメインとして数える
    ["見て-misskey.io", 27],
    // X はかたまりの中の 2 つ目のプロトコルから、国際化ドメインの URL を始める
    ["x https://a.example/?u=http://日本.com", 46],
    [
      "x https://a.example/?u=http://한국.com&v=http://한국.com&w=http://한국.com",
      98,
    ],
    ["a.xn--p1ai@x", 25],
    // X は 2 つ目以降のラベルの先頭と末尾に - を許さず、その手前でドメインを終える
    ["misskey.io.-example.com", 36],
    ["a.com.b-.c.com", 32],
    // 英字以外の TLD は 1 文字 2 と数える
    ["/abcdefghijklmnopqrstu.みんな", 29],
    // URL の直前で TLD が終わるかは、URL の最初の文字まで見て決める
    ["え.jpmisskey.io.x.comindex.json.みんなhttps://a.co", 72],
  ])("%s を X より少なく数えない", (text, x) => {
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

  test("一覧にない TLD の URL は、X と同じく URL として数えない", () => {
    const text = "https://example.invalid/x";
    expect(weightedLength(text)).toBe(text.length);
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

  test("語の途中で切って残った部分を X が URL として数えても、上限を超えない", () => {
    // photo.jpeg を photo.jp で切ると、X は photo.jp を 23 と数える
    const text = `${"あ".repeat(134)}x photo.jpeg を添付${"い".repeat(200)}`;
    const r = truncateWeighted(text);
    expect(r.truncated).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
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

  test("- で始まるラベルの手前で終わるドメインが並んでも、X の上限を超えない", () => {
    // X は 415 と数える。ドメインを - をまたいで 1 つと数えると 272 になり、切り詰めない
    const r = truncateWeighted(
      `${"misskey.io.-example.com ".repeat(11)}${"あ".repeat(4)}`,
    );
    expect(r.truncated).toBe(true);
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
