import { describe, expect, test } from "vitest";
import {
  buildPost,
  defuseMentions,
  shouldForward,
  stripCustomEmoji,
  stripMfm,
} from "../src/transform";
import { MAX_WEIGHTED_LENGTH, weightedLength } from "../src/weighted-length";
import { makeConfig, makeNote } from "./helpers";

const config = makeConfig();

describe("shouldForward", () => {
  test("公開ノートは転送する", () => {
    expect(shouldForward(makeNote(), config)).toEqual({ ok: true });
  });

  test.each([
    ["followers", { visibility: "followers" }],
    ["specified", { visibility: "specified" }],
  ])("公開範囲 %s は転送しない", (_, o) => {
    expect(shouldForward(makeNote(o), config).ok).toBe(false);
  });

  test("連合なしは転送しない", () => {
    expect(shouldForward(makeNote({ localOnly: true }), config)).toEqual({
      ok: false,
      reason: "local-only",
    });
  });

  test("返信は既定で転送しない", () => {
    const note = makeNote({ replyId: "r1" });
    expect(shouldForward(note, config).ok).toBe(false);
    expect(shouldForward(note, makeConfig({ includeReplies: true })).ok).toBe(
      true,
    );
  });

  test("本文のない Renote は転送しないが、引用は転送する", () => {
    expect(
      shouldForward(makeNote({ renoteId: "x", text: null }), config),
    ).toEqual({ ok: false, reason: "pure-renote" });
    expect(
      shouldForward(makeNote({ renoteId: "x", text: "引用" }), config).ok,
    ).toBe(true);
  });

  test("CW は既定で転送しない", () => {
    const note = makeNote({ cw: "ネタバレ" });
    expect(shouldForward(note, config)).toEqual({ ok: false, reason: "cw" });
    expect(shouldForward(note, makeConfig({ cwMode: "include" })).ok).toBe(
      true,
    );
  });

  test("除外タグ付きは転送しない（大文字小文字を区別しない）", () => {
    expect(shouldForward(makeNote({ tags: ["NoX"] }), config)).toEqual({
      ok: false,
      reason: "exclude-tag:NoX",
    });
  });
});

describe("stripMfm", () => {
  test("$[fn ...] を中身だけにする（入れ子も）", () => {
    expect(stripMfm("$[tada すごい]")).toBe("すごい");
    expect(stripMfm("$[x2 $[spin.speed=1s くるくる]]")).toBe("くるくる");
    expect(stripMfm("$[fg.color=f00 赤] と $[blur 秘密]")).toBe("赤 と 秘密");
  });

  test("MFM タグと太字・打ち消し記号を取り除く", () => {
    expect(stripMfm("<center>**太字**</center>")).toBe("太字");
    expect(stripMfm("<small>小さい</small> ~~消し~~")).toBe("小さい 消し");
  });

  test.each([
    ["[公式](https://example.com)", "公式 https://example.com"],
    ["?[x](https://a.b)", "x https://a.b"],
    ["[https://a.com](https://a.com)です", "https://a.comです"],
    [
      "[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))",
      "Wiki https://en.wikipedia.org/wiki/Foo_(bar)",
    ],
    ["[$[x2 a]](https://a.com)", "a https://a.com"],
    ["$[tada [a](https://a.com)]", "a https://a.com"],
    ["$[tada [a](https://a.com)]です", "a https://a.comです"],
    ["$[tada [a](https://a.com)]x", "a https://a.com x"],
    ["**[a](https://a.com)**です", "a https://a.comです"],
    ["see[https://a.com](https://a.com)", "see https://a.com"],
    ["見て[https://a.com](https://a.com)", "見てhttps://a.com"],
    ["See [docs](https://x.com).", "See docs https://x.com."],
    ["[a](https://x.com), ok", "a https://x.com, ok"],
    ["[a](https://x.com).html", "a https://x.com .html"],
    ["[a](https://a.com)[b](https://b.com)", "a https://a.com b https://b.com"],
    ["[a](https://a.com/path)続き", "a https://a.com/path続き"],
    ["詳しくは[こちら](https://a.com)。", "詳しくはこちら https://a.com。"],
    ["([a](https://a.com))", "(a https://a.com)"],
    ["[a](https://a.com/path):blob:", "a https://a.com/path :blob:"],
  ])("リンク記法 %s を label url にする", (input, expected) => {
    expect(stripMfm(input)).toBe(expected);
  });
});

describe("stripCustomEmoji", () => {
  test(":name: を取り除き、余分な空白を詰める", () => {
    expect(stripCustomEmoji("やった :blobcat_yay: ね")).toBe("やった ね");
  });

  test("時刻のような数字だけの並びは残す", () => {
    expect(stripCustomEmoji("12:30:45 に集合")).toBe("12:30:45 に集合");
  });

  test.each([
    ["行末 :blob:", "行末"],
    ["a:blob: b", "a b"],
    ["x :a: :b: y", "x y"],
    ["  :blob: インデント", "  インデント"],
    ["1 行目 :a:\n2 行目", "1 行目\n2 行目"],
    ["before :blob: https://example.com", "before https://example.com"],
    ["https://a.com :blob: https://b.com", "https://a.com https://b.com"],
    ["https://a.com :blob:", "https://a.com"],
  ])("%j の空白を整える", (input, expected) => {
    expect(stripCustomEmoji(input)).toBe(expected);
  });

  test("URL の直前の絵文字を取り除いても、URL の中は変えない", () => {
    // 詰めると英数字の直後の URL になり X がリンクにしないので、空白で区切る
    expect(stripCustomEmoji("abc:blob:https://a.com/:x:")).toBe(
      "abc https://a.com/:x:",
    );
  });

  test("CRLF の行末の絵文字は前の空白ごと取り除く", () => {
    expect(stripCustomEmoji("行末 :blob:\r\n次")).toBe("行末\r\n次");
  });

  test("URL の直後に全角の句読点を挟んだ絵文字も取り除く", () => {
    expect(stripCustomEmoji("https://example.com/page、:blobcat: すごい")).toBe(
      "https://example.com/page、 すごい",
    );
  });

  test("空白と閉じていない :name の長い並びでも時間がかからない", () => {
    const text = `${" ".repeat(1000)}:${"a".repeat(1999)}`;
    const started = performance.now();
    expect(stripCustomEmoji(text)).toBe(text);
    // 修正前の正規表現では約 2 秒かかっていた。遅い CI でも誤検知しない余裕を持たせる
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("前後に英数字が続く絵文字も取り除く", () => {
    expect(stripCustomEmoji("a:blob:b")).toBe("ab");
  });

  test("絵文字のない箇所の連続する空白は詰めない", () => {
    expect(stripCustomEmoji("a  b")).toBe("a  b");
  });

  test("URL の中の :name: は変えない", () => {
    const url = "https://ja.wikipedia.org/wiki/Help:Contents:x";
    expect(stripCustomEmoji(`見て ${url}`)).toBe(`見て ${url}`);
  });
});

describe("defuseMentions", () => {
  test("@ の直後にゼロ幅スペースを挟む", () => {
    expect(defuseMentions("@alice と @bob@misskey.io")).toBe(
      "@​alice と @​bob@misskey.io",
    );
  });

  test("メールアドレスは変更しない", () => {
    expect(defuseMentions("mail: a@example.com")).toBe("mail: a@example.com");
  });

  test("URL の中の @ は変えない", () => {
    expect(defuseMentions("見て https://misskey.io/@alice/123 と @bob")).toBe(
      "見て https://misskey.io/@alice/123 と @\u200Bbob",
    );
    expect(defuseMentions("HTTPS://misskey.io/@alice")).toBe(
      "HTTPS://misskey.io/@alice",
    );
  });

  test.each([
    ["見て https://misskey.io/notes/abc。@alice", "abc。@\u200Balice"],
    ["https://example.com/post、@alice", "post、@\u200Balice"],
    ["https://example.comです@alice", "comです@\u200Balice"],
    // X がリンクにしない URL（TLD なし、英字の直後）の中のメンションも無害化する
    ["http://localhost:3000/@alice", "3000/@\u200Balice"],
    ["nicehttps://misskey.io/@alice", "io/@\u200Balice"],
    ["#https://example.com/@alice", "com/@\u200Balice"],
    ["https://example-.com/@alice", "com/@\u200Balice"],
  ])("%s の X で URL にならない部分のメンションは無害化する", (input, tail) => {
    expect(defuseMentions(input).endsWith(tail)).toBe(true);
  });

  test.each([
    ["＠alice さん", "＠\u200Balice さん"],
    ["こんにちは＠bob", "こんにちは＠\u200Bbob"],
    ["RT@bob", "RT@\u200Bbob"],
    ["RT:@bob", "RT:@\u200Bbob"],
    ["見て RT@bob", "見て RT@\u200Bbob"],
    ["rt@bob", "rt@\u200Bbob"],
    // X も英数字や . の直後の RT はメンションにしない
    ["ok.RT@bob", "ok.RT@bob"],
  ])("%s の全角 ＠ や RT の直後のメンションも無害化する", (input, expected) => {
    expect(defuseMentions(input)).toBe(expected);
  });

  test.each([
    [
      "参考 https://example.com/article(@alice さん作)",
      "article(@\u200Balice さん作)",
    ],
    ["https://a.com/x×@alice", "x×@\u200Balice"],
    ["https://a.com/?q=é@alice", "é@\u200Balice"],
    ["https://a.com#@alice", "#@\u200Balice"],
  ])("%s の X で URL の外になる部分のメンションは無害化する", (input, tail) => {
    expect(defuseMentions(input).endsWith(tail)).toBe(true);
  });

  test("X がリンクにしない TLD の URL の中のメンションは無害化する", () => {
    expect(defuseMentions("https://example.invalid/@alice")).toBe(
      "https://example.invalid/@\u200Balice",
    );
  });

  test("Misskey のサーバーでよく使われる gTLD の URL の中の @ は変えない", () => {
    const url = "https://sushi.ski/@alice";
    expect(defuseMentions(url)).toBe(url);
  });

  test("サブドメインに _ を含む URL の中の @ は変えない", () => {
    const url = "https://my_site.example.com/@alice";
    expect(defuseMentions(url)).toBe(url);
  });

  test("括弧で囲んだ URL の直後のメンションは無害化する", () => {
    expect(defuseMentions("(https://example.com)@alice")).toBe(
      "(https://example.com)@\u200Balice",
    );
  });
});

describe("buildPost", () => {
  const link = "https://misskey.io/notes/a1b2c3";

  test("本文を整形し、画像は 4 枚まででセンシティブを除く", () => {
    const files = [
      {
        id: "1",
        type: "image/png",
        url: "https://f/1.png",
        isSensitive: false,
      },
      {
        id: "2",
        type: "image/jpeg",
        url: "https://f/2.jpg",
        isSensitive: true,
      },
      {
        id: "3",
        type: "video/mp4",
        url: "https://f/3.mp4",
        isSensitive: false,
      },
      ...[4, 5, 6, 7].map((n) => ({
        id: String(n),
        type: "image/webp",
        url: `https://f/${n}.webp`,
        isSensitive: false,
      })),
    ];
    const post = buildPost(
      makeNote({ text: "$[tada やった] :blob: @alice", files }),
      config,
      link,
    );
    expect(post.text).toBe("やった @​alice");
    expect(post.imageUrls).toEqual([
      "https://f/1.png",
      "https://f/4.webp",
      "https://f/5.webp",
      "https://f/6.webp",
    ]);
    expect(post.truncated).toBe(false);
  });

  test("CW を含める設定では CW 文を先頭に付ける", () => {
    const post = buildPost(
      makeNote({ cw: "注意", text: "本文" }),
      makeConfig({ cwMode: "include" }),
    );
    expect(post.text).toBe("注意\n\n本文");
  });

  test("長文は切り詰め、既定ではリンクを付けない", () => {
    const post = buildPost(makeNote({ text: "あ".repeat(300) }), config, link);
    expect(post.truncated).toBe(true);
    expect(post.text).not.toContain(link);
    expect(weightedLength(post.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test.each([
    ["never", false],
    ["truncated", true],
  ] as const)(
    "無害化で長くなる本文も上限に収める（appendLink: %s）",
    (appendLink, hasLink) => {
      // 無害化の前は 278 で、ゼロ幅スペースを挟むと 280 を超える
      const text = `${"a".repeat(266)} @b @c @d @e`;
      const post = buildPost(
        makeNote({ text }),
        makeConfig({ appendLink }),
        link,
      );
      expect(post.truncated).toBe(true);
      expect(post.text.endsWith(link)).toBe(hasLink);
      expect(weightedLength(post.text)).toBeLessThanOrEqual(
        MAX_WEIGHTED_LENGTH,
      );
    },
  );

  test("truncated 設定では切り詰めたときだけリンクを付ける", () => {
    const c = makeConfig({ appendLink: "truncated" });
    expect(buildPost(makeNote({ text: "短い" }), c, link).text).toBe("短い");
    const long = buildPost(makeNote({ text: "あ".repeat(300) }), c, link);
    expect(long.text.endsWith(`…\n${link}`)).toBe(true);
    expect(weightedLength(long.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test.each([
    ["**:fire:**Hot", "Hot"],
    ["$[tada :blob:]2024年", "2024年"],
  ])("MFM の記号に囲まれた絵文字 %s も取り除く", (text, expected) => {
    expect(buildPost(makeNote({ text }), config).text).toBe(expected);
  });

  test("リンク記法の直後のカスタム絵文字は取り除き、URL は変えない", () => {
    const post = buildPost(
      makeNote({ text: "[a](https://a.com/path):blob:" }),
      config,
    );
    expect(post.text).toBe("a https://a.com/path");
  });

  test("隣り合うリンク記法の URL はどちらもそのまま残る", () => {
    const post = buildPost(
      makeNote({ text: "[a](https://a.com)[b](https://b.com)" }),
      config,
    );
    expect(post.text).toBe("a https://a.com b https://b.com");
  });

  test("always 設定では常にリンクを付ける", () => {
    const c = makeConfig({ appendLink: "always" });
    expect(buildPost(makeNote({ text: "短い" }), c, link).text).toBe(
      `短い\n${link}`,
    );
  });

  test("always 設定で本文がなければ、リンクだけにする", () => {
    const c = makeConfig({ appendLink: "always" });
    const note = makeNote({
      text: null,
      files: [
        {
          id: "f1",
          type: "image/png",
          url: "https://files.example/a.png",
          isSensitive: false,
        },
      ],
    });
    expect(buildPost(note, c, link).text).toBe(link);
  });

  test("カスタム絵文字の除去を無効にすると、ショートコードを残す", () => {
    const c = makeConfig({ stripCustomEmoji: false });
    expect(buildPost(makeNote({ text: ":blob: hi" }), c).text).toBe(
      ":blob: hi",
    );
  });
});
