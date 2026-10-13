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

  // twitter-text 3.1.0 と同じく、後ろのドメインだけを URL として数える
  test.each([
    ["https://example.com+misskey.io", 43],
    ["https://x.jp@#:*~a.co", 40],
  ])("findUrls が拾わない %s は、X と同じく %i", (text, x) => {
    expect(weightedLength(text)).toBe(x);
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
    // X はラベルにアクセント付きの文字を許す
    ["café.com", 23],
    ["é.コム", 23],
    // X は国際化ドメインの URL を、走査で読んだかたまりの終わりまでとし、残りを文字として数える
    ["https://café.com/a).", 25],
    ["https://é.com_abc", 27],
    ["https://é.com(@x)", 27],
    ["https://é.co!!!", 26],
    // X はプロトコルの後ろでドメインにならない部分を飛ばし、その先のドメインを URL として数える
    ["https://(a.中国", 32],
    ["x https://a.b/c,example.中国", 39],
    ["http://localhost:8080/x&a.みんな", 47],
    // X はアクセント付きの文字を URL の直前の文字として消費し、その後ろから URL を始める
    ["ḁa.jp", 25],
    ["$aéa.jp", 26],
    ["@éa.jp", 25],
    // X はクエリの終わりまでを消費し、その後ろのアクセント付きの文字を直前の文字として、
    // その後ろから URL を始める
    ["例え.jp?q=1caféa.jp", 38],
    ["http://a.jp/éb.cx.comq=?u=coméexample.com", 47],
    // X は伸ばした URL の文字列（`a.com/x`）の長さだけ読み飛ばし、割れた絵文字の並びを文字ごとに数える
    ["a.com👨‍👩‍👧あ.jp/x", 36],
    ["a.com👨‍👩‍👧あ.jp:80/x", 36],
    ["a.com👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧あ.jp/x", 42],
    // X は `❤️` の `❤` を URL の直前の文字として消費し、異体字セレクターからかたまりを読む。
    // 結合文字は、1 つ目を直前の文字として消費する
    ["❤️a.com", 25],
    ["@❤️a.com", 26],
    ["\u0301\u0301a.com", 24],
    // X はスラッグが長すぎる t.co の URL を、URL にせず文字として数える
    [`https://t.co/${"a".repeat(41)}`, 54],
    [`https://t.co/${"a".repeat(41)}/x`, 56],
    // X は t.co の URL をスラッグまでにし、残りを文字として数える。1 文字 2 の文字は 2
    ["https://t.co/abc/xyz", 27],
    [`https://t.co/abc/${"a".repeat(300)}`, 324],
    ["https://t.co/abc/ếạ", 28],
    // X は Punycode に変換したラベルが 63 文字を超える URL を、URL にせず文字として数える
    [`https://${"日本語한국어".repeat(6)}.com/x`, 86],
    [`https://${"a".repeat(13)}${"日本語한국어".repeat(3)}.com/x`, 63],
    // 変換後のラベルの長さは、文字の並びで変わる（Punycode の bias の調整）
    [
      `https://ドメイン公式情報ゲーム大阪カタカナさくら会社ゲーム.jp/${"a".repeat(20)}`,
      82,
    ],
    [
      `https://ゲーム한국2024뉴스東京ニュースさくらカタカナ.jp/${"a".repeat(20)}`,
      76,
    ],
    [
      `https://륶ソユja룣ゼヰ갗갢쳑툐ィf쒶쉫xなょヰみメぐ.jp/${"a".repeat(20)}`,
      74,
    ],
    [`https://${"a".repeat(37)}한국어東京.com/x`, 61],
    [`https://aaaaaa${"日本語さくら".repeat(5)}.com/x`, 80],
    // X は 。・｡ も . にして変換し、区切りを含めて 64 文字のラベルを URL にしない
    [`https://x.${"a".repeat(31)}。${"b".repeat(32)}.com/x`, 81],
    [`https://x.${"a".repeat(31)}｡${"b".repeat(32)}.com/x`, 81],
    // X は xn-- で始まり、validAsciiDomain のドメインを含まないホストを URL にしない
    [`https://xn--例.com/${"a".repeat(100)}`, 119],
    // Prepend の文字（U+0600）は、直後のプロトコル付きの URL と別に数える
    ["\u0600https://a.com", 24],
  ])("%s を X より少なく数えない", (text, x) => {
    expect(weightedLength(text)).toBeGreaterThanOrEqual(x);
  });

  test("findUrls が拾わないプロトコル付きのかたまりは、X が URL とみなす場合と同じく 23", () => {
    expect(weightedLength("https://例.jp")).toBe(23);
    expect(weightedLength("https://café.com")).toBe(23);
    expect(weightedLength(`${"あ".repeat(130)} https://例.jp`)).toBe(
      260 + 1 + 23,
    );
  });

  test("アクセント付きの文字を含むドメインは、X と同じく 23 として切り詰める", () => {
    // X は 23 + 1 + 257 = 281 で、上限を超える
    const r = truncateWeighted(`café.com ${"x".repeat(257)}`);
    expect(r.truncated).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test("findUrls が拾わない、日本語を含む長いかたまりも途中で切り詰める", () => {
    // X は Punycode に変換したラベルが 63 文字を超えるかたまりを URL にせず、文字として数える（422）
    const text = `https://example.com${"あ".repeat(200)}.jp`;
    const r = truncateWeighted(text);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("https://example.comあ")).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test.each([
    // X は 。 も . として Punycode に変換し、変換後のラベルの長さで確かめる
    [`https://x.${"a".repeat(58)}。b.com/notes/abc`],
    // 変換後のラベルは、。を . にした 63 文字
    [`https://x.${"a".repeat(31)}。${"b".repeat(31)}.com/x`],
    [`https://x.${"a".repeat(31)}．${"b".repeat(31)}.com/x`],
    [`https://x.${"a".repeat(31)}｡${"b".repeat(31)}.com/x`],
    // 変換後のラベルは 63 文字。末尾に ム を足すと 64 文字で、X は URL にしない
    [
      `https://ドメイン公式情報ゲーム大阪カタカナさくら会社ゲー.jp/${"a".repeat(20)}`,
    ],
    // ASCII と日本語が混ざったラベルは、変換後に 62 文字
    [`https://${"a".repeat(12)}${"日本語한국어".repeat(3)}.com/x`],
    // 変換後のラベルは 63 文字。a を 1 つ足すと 64 文字で、X は URL にしない
    [`https://${"a".repeat(36)}한국어東京.com/x`],
    // 変換後のラベルは 60 文字。a を 1 つ足すと 64 文字に跳ぶ
    [`https://aaaaa${"日本語さくら".repeat(5)}.com/x`],
    // X はホストの日本語ごと 1 つの URL にする
    ["https://example.comを見てください。詳細はmisskey.io"],
  ])("X が URL とみなす国際化ドメインのかたまり %s は 23", (text) => {
    expect(weightedLength(text)).toBe(23);
  });

  test("国際化ドメインの URL の長さの上限は、X と同じく変換前の長さで確かめる", () => {
    // X はプロトコルの長さと URL の長さの和が 4096 までなら URL にする
    expect(weightedLength(`https://例え.jp/${"a".repeat(4074)}`)).toBe(23);
    expect(weightedLength(`https://例え.jp/${"a".repeat(4075)}`)).toBe(4091);
  });

  test("X が URL とみなす長い国際化ドメインの URL は、切り詰めない", () => {
    // X は 256 + 1 + 23 = 280 で、上限に収まる
    const text = `${"あ".repeat(128)} https://例え.jp/${"a".repeat(4070)}`;
    expect(truncateWeighted(text)).toEqual({ text, truncated: false });
  });

  test("xn-- で始まるホストの URL も、X が URL とみなさない長さなら途中で切り詰める", () => {
    // X は 4096 文字を超える URL をリンクにせず、文字として数える
    const r = truncateWeighted(`https://xn--é.com/${"a".repeat(4100)}`);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("https://xn--é.com/a")).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test("パスを伸ばすドメインより前の絵文字は、文字ごとに数えない", () => {
    // X は `a.com/x` を 1 つの URL（23）とし、本文を 25 と数える
    expect(weightedLength("👨‍👩‍👧a.com/x")).toBe(2 + 23);
  });

  test("X が URL とみなす、ラベルに 。 を含むかたまりは、途中で切らずに落とす", () => {
    const r = truncateWeighted(
      // X は 260 + 1 + 23 = 284 で、上限を超える
      `${"あ".repeat(130)} https://x.${"a".repeat(58)}。b.com/notes/abc`,
    );
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain("https://");
  });

  test("スラッグが長すぎる t.co の URL は、文字として数えて切り詰める", () => {
    // X は 240 + 1 + 73 = 314 で、上限を超える
    const r = truncateWeighted(
      `${"あ".repeat(120)} https://t.co/${"a".repeat(60)}`,
    );
    expect(r.truncated).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test("t.co の URL を縮めた残りも、文字として数えて切り詰める", () => {
    // X は 240 + 1 + 23 + 61 = 325 で、上限を超える
    const r = truncateWeighted(
      `${"あ".repeat(120)} https://t.co/abc/${"a".repeat(60)}`,
    );
    expect(r.truncated).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test("パスの終わりで走査が書記素を割っても、書記素を割らずに切り詰める", () => {
    // 走査は `#️⃣` の `#` でパスを終える。X は 254 + 1 + 23 + 4 = 282 で、上限を超える
    const r = truncateWeighted(`${"x".repeat(254)} https://a.com/#️⃣`);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toMatch(/#(?!\uFE0F\u20E3)/u);
  });

  test("走査が書記素の途中で区切っても、書記素を割らずに切り詰める", () => {
    const r = truncateWeighted(`${"x".repeat(274)}#❤️a.com`);
    expect(r.truncated).toBe(true);
    // 異体字セレクターだけを落とすと、絵文字の表示が変わる
    expect(r.text).not.toMatch(/❤(?!\uFE0F)/u);
  });

  test("X がリンクにしうる国際化ドメインの URL は、途中で切らずに落とす", () => {
    const r = truncateWeighted(
      // X は 260 + 1 + 23 = 284 で、上限を超える
      `${"あ".repeat(130)} https://café.com/notes/abcdefghijklmnop`,
    );
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain("https://");
  });

  test("プロトコルのないドメインにパスが続くと、パスの途中で切らずに落とす", () => {
    // X は 260 + 1 + 23 = 284 で、上限を超える。
    // パスの途中で切ると、X は短いパスへのリンクにする
    const r = truncateWeighted(
      `${"あ".repeat(130)} example.com/aaaa/bbbb/cccc/dddd`,
    );
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain("example.com");
  });

  test("絵文字の直後のドメインも、絵文字を割らずに数えて切り詰める", () => {
    // 走査は絵文字の上位サロゲートを直前の文字として消費し、下位サロゲートから読む
    expect(weightedLength("🙂a.com")).toBe(25);
    const r = truncateWeighted(`${"あ".repeat(137)} #🙂misskey.io`);
    expect(r.truncated).toBe(true);
    // u フラグでは、対になったサロゲートは 1 つのコードポイントになり、ここに当たらない
    expect(r.text).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  test("NFC に正規化してから数える", () => {
    // `≠` は NFC で U+2260 になり、2 と数える。X は 25
    expect(weightedLength("https://a.com/x=\u0338")).toBeGreaterThanOrEqual(25);
    // X は 256 + 1 + 25 = 282 で、上限を超える
    const r = truncateWeighted(`${"x".repeat(256)} https://a.com/x=\u0338`);
    expect(r.truncated).toBe(true);
  });

  test("隣り合うかたまりで書記素の始まりまで戻しても、文字を重ねずに切り詰める", () => {
    const text = `${"あ".repeat(120)}a.com/#️⃣b.com/#️⃣c.com${"い".repeat(20)}`;
    const r = truncateWeighted(text);
    expect(r.truncated).toBe(true);
    expect(text.startsWith(r.text.slice(0, -1))).toBe(true);
  });

  test("濁点の結合文字を、手前のかなと分けずに切り詰める", () => {
    const r = truncateWeighted(`${"x".repeat(274)} #あ\u3099a.com`);
    expect(r.text).not.toMatch(/あ(?!\u3099)/u);
  });

  test("半角の濁点を、手前の半角のかなと分けずに切り詰める", () => {
    const r = truncateWeighted(`${"x".repeat(274)} #ｶﾞa.com`);
    expect(r.text).not.toMatch(/ｶ(?!ﾞ)/u);
  });

  test("Prepend の文字を、直後の文字と分けずに切り詰める", () => {
    const r = truncateWeighted(`${"x".repeat(274)} #\u0600a.com`);
    expect(r.text).not.toMatch(/\u0600(?!a)/u);
  });

  test.each([
    // ラベルの途中から読み始めると、位置ごとに終わりまで読み直す
    ["ドットのない長いラベル", `x.${"a".repeat(30000)}あ.com`],
    // 変換後の長さを、文字の種類数と長さに比例する時間をかけて求めない
    [
      "文字の種類の多い長いホスト",
      `https://${Array.from({ length: 30000 }, (_, i) => String.fromCodePoint(0x4e00 + (i % 20000))).join("")}.com`,
    ],
  ])("%s でも時間がかからない", (_, text) => {
    const started = performance.now();
    weightedLength(text);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("長い本文でも例外にならない", () => {
    const text = "a".repeat(150000);
    expect(weightedLength(text)).toBe(150000);
    expect(truncateWeighted(text).truncated).toBe(true);
  });

  test("プロトコルのないかたまりのパスの中のドメインは、URL に含めて数える", () => {
    // X は `a.jp/b.com` を 1 つの URL（23）とし、本文を 25 と数える
    expect(weightedLength("例a.jp/b.com")).toBe(2 + 23);
  });

  test("プロトコルのないドメインにパスが続くと、X と同じくパスまでを 23 と数える", () => {
    expect(weightedLength("example.com/aaaa/bbbb/cccc/dddd")).toBe(23);
    expect(weightedLength("見て example.com/aaaa/bbbb")).toBe(4 + 1 + 23);
    expect(weightedLength("misskey.io:443/notes?x=1")).toBe(23);
  });

  test("プロトコルのないドメインにパスがなければ、ポートとクエリは文字として数える", () => {
    expect(weightedLength("a.com:8080")).toBe(23 + 5);
    expect(weightedLength("a.com?x=1")).toBe(23 + 4);
  });

  test("かたまりの中の手前のドメインは 23 とし、最後のドメインだけをパスまで伸ばす", () => {
    expect(weightedLength("a.comあb.com/x")).toBe(23 + 2 + 23);
  });

  test("かたまりの中に同じドメインが続いても、前の URL の後ろから探す", () => {
    expect(weightedLength("a.comとa.com/x")).toBe(23 + 2 + 23);
    expect(weightedLength("a.comとa.com")).toBe(23 + 2 + 23);
    const r = truncateWeighted(`a.comとa.com/x ${"い".repeat(20)}`, 40);
    expect(r).toEqual({ text: "a.comと…", truncated: true });
  });

  test.each([
    // X は URL の始まりを、手前に英数字を続けて現れる同じ文字列（`a.comx` の `a.com`）とし、
    // そこから伸ばした URL の長さだけ読み飛ばす。残りの割れた文字は文字ごとに数える
    ["a.comx👨‍👩‍👧a.com/y", 38],
    ["a.comx𠀀a.com/y", 32],
    ["b.jp1👨‍👩‍👧b.jp/1", 37],
  ])("手前に同じ文字列があるドメインの %s は、X と同じく %i", (text, x) => {
    expect(weightedLength(text)).toBe(x);
  });

  test("最後のドメインより後ろにドメインの部分が残れば、X と同じくその文字数だけ末尾を数える", () => {
    // X は伸ばした URL の文字列（`a.com/x`）の長さだけ読み飛ばし、残りの `jp/x` を数える
    expect(weightedLength("a.comあ.jp/x")).toBe(23 + 4);
  });

  test.each([
    // X は直前が -・_・.・/ のプロトコルのないかたまりを URL にしない
    ["/misskey.io", 11],
    ["-example.com/x", 14],
    ["見て_a.com/x", 4 + 8],
    ["x..a.com/x", 10],
    // ASCII のドメインを含まないかたまりは、パスがあっても URL にしない
    ["あ 例え.jp/xxxx", 15],
    // ラベルが 63 文字を超えるかたまりも URL にしない
    [`x.${"a".repeat(64)}.com/x`, 72],
    // 直前の文字に結合文字が続いても、直前の文字から数える
    ["/\u0301a.com/x", 9],
  ])(
    "X が URL にしないプロトコルのないかたまり %s は、文字として数える",
    (text, x) => {
      expect(weightedLength(text)).toBe(x);
    },
  );

  test("プロトコルのないかたまりの長さの上限は、https:// を付けた長さで確かめる", () => {
    // X は https:// の長さとかたまりの長さの和が 4096 までなら URL にする
    expect(weightedLength(`a.com/${"a".repeat(4082)}`)).toBe(23);
    expect(weightedLength(`a.com/${"a".repeat(4083)}`)).toBe(4089);
  });

  test("長さの上限で URL にしないかたまりは、途中で切らずに落とす", () => {
    // 途中で切ると、X は短いパスへのリンクにする
    const r = truncateWeighted(`見て a.com/${"a".repeat(4083)}`);
    expect(r).toEqual({ text: "見て…", truncated: true });
  });

  test("ラベルが長くて URL にしないかたまりも、ドメインより手前の日本語は残して切り詰める", () => {
    // 日本語の直後のドメインでは、日本語もラベルになり、63 文字を超えて X は URL にしない
    const text = `${"あ".repeat(100)}a.com/${"x".repeat(200)}`;
    expect(weightedLength(text)).toBe(200 + 206);
    const r = truncateWeighted(text);
    expect(r).toEqual({ text: `${"あ".repeat(100)}…`, truncated: true });
  });

  test("直前の文字で URL にしないかたまりは、途中で切って残す", () => {
    // X は 260 + 1 + 63 = 324 で、上限を超える。X は URL にしないので、途中で切ってもリンクにならない
    const r = truncateWeighted(
      `${"あ".repeat(130)} /example.com/${"a".repeat(50)}`,
    );
    expect(r).toEqual({
      text: `${"あ".repeat(130)} /example.com/aaaa…`,
      truncated: true,
    });
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

  test("プロトコルなしのドメインは長さに関係なく 23", () => {
    expect(weightedLength("example.com")).toBe(23);
    expect(weightedLength("見て example.com")).toBe(4 + 1 + 23);
    expect(weightedLength("a-very-long-subdomain.example.com")).toBe(23);
    expect(weightedLength("averyveryverylongdomainname.com")).toBe(23);
  });

  test("パスのないかたまりの「名前.国別の TLD」のドメインは、長さと 23 の大きいほう", () => {
    // 古い twitter-text（JS 版 1.x）はこの形を URL にしないので、X が長さで数えても少なくならないようにする
    const name = "averyveryverylongdomainname";
    expect(weightedLength(`${name}.jp`)).toBe(30);
    expect(weightedLength(`${name}.jp:80`)).toBe(30 + 3);
    expect(weightedLength("misskey.io")).toBe(23);
    expect(weightedLength("見て misskey.io")).toBe(4 + 1 + 23);
    // かたまりにパスがあれば、どちらの規則でも、伸ばさない手前のドメインを含めて URL になる
    expect(weightedLength(`${name}.jp/x`)).toBe(23);
    expect(weightedLength(`${name}.jpとb.com/x`)).toBe(23 + 2 + 23);
    // co と tv、サブドメインのあるドメインは、どちらの規則でも URL になる
    expect(weightedLength(`${name}.co`)).toBe(23);
    expect(weightedLength(`${name}.TV`)).toBe(23);
    expect(weightedLength(`sub.${name}.jp`)).toBe(23);
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

  test("指定した上限に収める", () => {
    // リンクを付けるときは、URL の分を空けた上限で切り詰める
    const r = truncateWeighted("あ".repeat(130), 256);
    expect(r.truncated).toBe(true);
    expect(weightedLength(r.text)).toBeLessThanOrEqual(256);
    // 切った残りの photo.jp を数え直しても、指定した上限に収める
    const text = `${"あ".repeat(122)}x photo.jpeg を添付${"い".repeat(200)}`;
    const recounted = truncateWeighted(text, 256);
    expect(weightedLength(recounted.text)).toBeLessThanOrEqual(256);
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
