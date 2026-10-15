import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config";
import {
  buildPost,
  defuseMentions,
  shouldForward,
  stripCustomEmoji,
  stripMfm,
} from "../src/transform";
import {
  findUrls,
  MAX_WEIGHTED_LENGTH,
  weightedLength,
} from "../src/weighted-length";
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

  test("除外タグは Misskey と同じく NFKC に正規化して比べる", () => {
    const c = loadConfig({ MISSKEY_HOOK_SECRET: "s", EXCLUDE_TAGS: "ﾃｽﾄ" });
    // Misskey は note.tags を NFKC に正規化して小文字にした形で送る
    expect(shouldForward(makeNote({ tags: ["テスト"] }), c)).toEqual({
      ok: false,
      reason: "exclude-tag:テスト",
    });
  });

  test("正規化していないノートのタグも、除外タグと比べられる", () => {
    expect(shouldForward(makeNote({ tags: ["ＮＯＸ"] }), config)).toEqual({
      ok: false,
      reason: "exclude-tag:ＮＯＸ",
    });
  });

  describe("note.tags が切り詰められたかもしれないとき", () => {
    // Misskey は note.tags を 32 個までしか保存しないので、33 個目以降の #nox は届かない
    const tags = Array.from({ length: 32 }, (_, i) => `t${i}`);
    const text = `${tags.map((t) => `#${t}`).join(" ")} #nox`;

    test("本文の除外タグで除外する", () => {
      expect(shouldForward(makeNote({ tags, text }), config)).toEqual({
        ok: false,
        reason: "exclude-tag:nox",
      });
    });

    test("CW と投票の選択肢の除外タグでも除外する", () => {
      const cw = makeNote({ tags, text: "本文", cw: "注意 #nox" });
      expect(shouldForward(cw, makeConfig({ cwMode: "include" }))).toEqual({
        ok: false,
        reason: "exclude-tag:nox",
      });
      const poll = makeNote({
        tags,
        text: "本文",
        poll: { choices: [{ text: "はい" }, { text: "いいえ #nox" }] },
      });
      expect(shouldForward(poll, config)).toEqual({
        ok: false,
        reason: "exclude-tag:nox",
      });
    });

    test("note.tags が 32 個未満なら、本文は探さない", () => {
      const note = makeNote({ tags: tags.slice(1), text });
      expect(shouldForward(note, config)).toEqual({ ok: true });
    });

    // 全角の記号は、正規化する前は区切りにならない（Misskey のタグも `nox！` になる）
    test.each(["#noxious", "#nox。", "#nox！", "nox"])(
      "%j は除外タグのハッシュタグではないので除外しない",
      (tail) => {
        const note = makeNote({ tags, text: `${text.slice(0, -5)} ${tail}` });
        expect(shouldForward(note, config)).toEqual({ ok: true });
      },
    );

    test.each([
      "#nox)",
      "#nox\n続き",
      "#nox　続き",
      "#nox.",
      "#nox#a",
      "#noxious #nox",
      // 直前の文字は見ない。正規化すると全角の ａ が a になり、Misskey と判定がずれるため
      "ａ#nox",
      "a#nox",
      // 全角の ＃ は Misskey ではタグにならないが、多めに除外する
      "＃nox",
      "#nox＃a",
      // 結合文字は区切りの後ろにあっても、タグの正規化に影響しない
      "#nox≮",
    ])("%j は除外する", (tail) => {
      const note = makeNote({ tags, text: `${text.slice(0, -5)} ${tail}` });
      expect(shouldForward(note, config).ok).toBe(false);
    });

    test("切り出したタグを Misskey と同じく NFKC に正規化して比べ、書かれたままのタグを理由にする", () => {
      const c = loadConfig({
        MISSKEY_HOOK_SECRET: "s",
        EXCLUDE_TAGS: "テスト",
      });
      for (const tag of ["ﾃｽﾄ", "テスト"]) {
        const note = makeNote({ tags, text: `本文 #${tag}` });
        expect(shouldForward(note, c)).toEqual({
          ok: false,
          reason: `exclude-tag:${tag}`,
        });
      }
      const upper = makeNote({ tags, text: "本文 #NOX" });
      expect(shouldForward(upper, config)).toEqual({
        ok: false,
        reason: "exclude-tag:NOX",
      });
    });

    test("タグの外の文字は、タグの小文字化に影響しない", () => {
      // 語末の Σ は ς になる。本文ごと小文字にすると、後ろの文字で σ になり一致しない
      const c = loadConfig({ MISSKEY_HOOK_SECRET: "s", EXCLUDE_TAGS: "ΝΟΞΣ" });
      const note = makeNote({ tags, text: "本文 #ΝΟΞΣ.Α" });
      expect(shouldForward(note, c)).toEqual({
        ok: false,
        reason: "exclude-tag:ΝΟΞΣ",
      });
    });
  });
});

describe("stripMfm", () => {
  test("$[fn ...] を中身だけにする（入れ子も）", () => {
    expect(stripMfm("$[tada すごい]")).toBe("すごい");
    expect(stripMfm("$[x2 $[spin.speed=1s くるくる]]")).toBe("くるくる");
    expect(stripMfm("$[fg.color=f00 赤] と $[blur 秘密]")).toBe("赤 と 秘密");
  });

  test.each(["$[ x]", "$[]", "$[\nx]"])(
    "関数名のない %j は MFM の関数記法ではないので残す",
    (text) => {
      expect(stripMfm(text)).toBe(text);
    },
  );

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
    // X は .html を TLD とみなさず、続けても https://x.com までを URL にする
    ["[a](https://x.com).html", "a https://x.com.html"],
    ["[a](https://a.com)[b](https://b.com)", "a https://a.com b https://b.com"],
    ["[a](https://a.com/path)続き", "a https://a.com/path続き"],
    ["詳しくは[こちら](https://a.com)。", "詳しくはこちら https://a.com。"],
    ["([a](https://a.com))", "(a https://a.com)"],
    ["[a](https://a.com/path):blob:", "a https://a.com/path :blob:"],
    // 続く文字がクエリに取り込まれるときは区切る
    ["[検索](https://ex.com/?q=a)&です", "検索 https://ex.com/?q=a &です"],
    ["([link](https://ex.com/?a=1))x", "(link https://ex.com/?a=1 )x"],
    // クエリの末尾の + は取り込まれないので区切らない
    ["[l](https://ex.com/?q=a)+", "l https://ex.com/?q=a+"],
    // TLD の直後の @ で URL でなくなるので区切る
    ["[l](https://ex.com)@x", "l https://ex.com @x"],
    // ラベルのないリンクが隣り合っても、1 つの URL につなげない
    [
      "[ ](https://a.com/(x))[ ](https://b.com)",
      "https://a.com/(x) https://b.com",
    ],
    [
      "[https://a.com/x](https://a.com/x)[https://b.com](https://b.com)",
      "https://a.com/x https://b.com",
    ],
    // t.co の URL はスラッグまでだが、走査は後ろを消費するので、続けたリンクが消える
    [
      "[l](https://t.co/abc).[https://misskey.io/@b](https://misskey.io/@b)",
      "l https://t.co/abc .https://misskey.io/@b",
    ],
    // 手前の本文の URL のクエリに、ラベルのないリンクが取り込まれないよう区切る
    [
      "https://a.jp/x?q=[https://misskey.io/@b](https://misskey.io/@b)",
      "https://a.jp/x?q= https://misskey.io/@b",
    ],
    // パスに続くアクセント付きの文字は X が URL に含めるので区切る
    ["[記事](https://example.museum/x)é", "記事 https://example.museum/x é"],
    // findUrls が URL にしないリンク先（国際化ドメイン）でも、続く文字で読み方が変わるなら区切る
    ["[a](https://例え.jp/a)д", "a https://例え.jp/a д"],
    // X が URL にしないリンク先（一覧にない TLD）は、続けても読み方が変わらない
    ["[a](https://example.invalid/x)foo", "a https://example.invalid/xfoo"],
    ["[a](https://example.invalid/x).", "a https://example.invalid/x."],
    ["[a](https://example.invalid/x))", "a https://example.invalid/x)"],
    // ホストが途中で終わる（TLD の直後の + や @）なら区切る
    ["[公式](https://www.example.co.jp)+", "公式 https://www.example.co.jp +"],
    ["[公式](https://www.example.co.jp)@", "公式 https://www.example.co.jp @"],
    // 手前の本文の最後の 1 文字（: や %）も、続けるとパスやクエリになる
    [
      "example.com/:[ ](https://misskey.io/notes/1)",
      "example.com/: https://misskey.io/notes/1",
    ],
    [
      "t.co/%[https://ex.com/?q=a](https://ex.com/?q=a)",
      "t.co/% https://ex.com/?q=a",
    ],
    // 後ろの語が 1 文字だけでも区切る
    ["[記事](https://misskey.io)@", "記事 https://misskey.io @"],
    ["[記事](https://misskey.io)@ どうぞ", "記事 https://misskey.io @ どうぞ"],
    // ラベルのないリンクの後ろに本文が続くときも区切る
    [
      "[https://misskey.io/@alice](https://misskey.io/@alice)x",
      "https://misskey.io/@alice x",
    ],
    ["[https://a.com/x](https://a.com/x)'s", "https://a.com/x 's"],
    ["[ ](https://misskey.io)u", "https://misskey.io u"],
    // : の後ろのアクセント付きの文字は、パスとして URL に取り込まれる
    ["[ ](https://a.com/):été", "https://a.com/ :été"],
    // BOM の直後の URL は X が URL にしないので区切る
    ["\uFEFF[https://c.com](https://c.com)", "\uFEFF https://c.com"],
    // 後ろのリンクの手前が空白になると、後ろの本文と 1 つのホストになるので区切る
    [
      "[l](https://ex.com).x.com[https://misskey.io/@b](https://misskey.io/@b)",
      "l https://ex.com .x.com https://misskey.io/@b",
    ],
    // 手前の @ にゼロ幅スペースが入ると、手前のドメインがリンク先を取り込むので区切る
    [
      "@alicet.co/[ ](https://misskey.io/notes/1)",
      "@alicet.co/ https://misskey.io/notes/1",
    ],
    // 手前の URL のパスが長くても、そのクエリにリンク先を取り込ませない
    [
      `https://a.jp/${"a".repeat(61)}?q=[https://misskey.io/@b](https://misskey.io/@b)`,
      `https://a.jp/${"a".repeat(61)}?q= https://misskey.io/@b`,
    ],
    // 日本語もドメインの文字なので、後ろのドメインとつながる
    ["[記事](https://a.com)とmisskey.io", "記事 https://a.com とmisskey.io"],
    // クエリの % も URL に含まれる
    [
      "[検索](https://a.com/?q=%E3%81%82)1",
      "検索 https://a.com/?q=%E3%81%82 1",
    ],
    // URL に続けると、X がハッシュタグやキャッシュタグとして扱わなくなる
    ["[lbl](https://a.com)#tag", "lbl https://a.com #tag"],
    ["[lbl](https://a.com)＃tag", "lbl https://a.com ＃tag"],
    ["[lbl](https://a.com)$TSLA", "lbl https://a.com $TSLA"],
    // 手前のタグに URL を続けると、X はタグとして扱わなくなる
    [
      "#お知らせ[https://example.com](https://example.com)",
      "#お知らせ https://example.com",
    ],
    ["#tag_[ ](https://a.co)", "#tag_ https://a.co"],
    ["#ねこ〜[ ](https://example.com)", "#ねこ〜 https://example.com"],
    // 崩れた MFM でも、続く .jp でホストが変わるので区切る
    [
      "見て$[tada[公式](https://example.com)].jp",
      "見てhttps://example.com .jp",
    ],
    // 崩れた MFM で、関数名が目印と URL を取り込まない
    ["abc$[tada[ ](https://a.com)]", "abc https://a.com"],
    ["$[tada[ ](https://a.com) x]", "https://a.com x"],
    // URL の途中から $[...] の展開が始まり、URL の後ろを判定できないときは区切る
    ["a$[tada[ ](https://a.com/]x)y", "a https://a.com/x y"],
    // 崩れた MFM でラベルの後ろの空白がなくなっても、URL の手前を区切る
    ["abc$[tada[公式](https://example.com)]", "abc https://example.com"],
    ["$TSLA$[tada[公式](https://example.com)]", "$TSLA https://example.com"],
  ])("リンク記法 %s を label url にする", (input, expected) => {
    expect(stripMfm(input)).toBe(expected);
  });

  test("確かめる長さの上限を超える手前の本文とは、確かめずに区切る", () => {
    // X は URL にしないかたまりも長さによらず消費するので、リンク先を取り込む
    const head = `a.com/${"x".repeat(5000)}/`;
    expect(
      stripMfm(`${head}[https://misskey.io/@b](https://misskey.io/@b)`),
    ).toBe(`${head} https://misskey.io/@b`);
  });

  test("空白のない長い本文にリンクが並んでも時間がかからない", () => {
    const text = "あ[ ](https://a.com/x)".repeat(140);
    const started = performance.now();
    stripMfm(text);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("確かめる文字数の上限を使い切った後は、確かめずに区切る", () => {
    const text = `${"あ[ ](https://a.com/x)".repeat(120)}[l](https://b.com)x`;
    expect(stripMfm(text).endsWith("l https://b.com x")).toBe(true);
  });

  test("確かめる文字数の上限をちょうど超える判定でも、リンクをつなげない", () => {
    for (let n = 1; n <= 60; n++) {
      expect(
        findUrls(stripMfm("あx[ ](https://a.com/x)".repeat(n))),
      ).toHaveLength(n);
    }
  });

  test("閉じていない $[ の後ろの長い本文でも時間がかからない", () => {
    const text = `$[${"あ".repeat(50000)}`;
    const started = performance.now();
    expect(stripMfm(text)).toBe(text);
    // 関数名と中身の境目をすべて試すと、長さの二乗で約 1 秒かかる
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("閉じていない $[ の内側の入れ子は展開する", () => {
    const head = `$[${"a".repeat(2800)}`;
    const text = `${head}${"$[x ".repeat(31)}y${"]".repeat(31)}`;
    expect(stripMfm(text)).toBe(`${head}y`);
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

  test("直後に // が続く絵文字も取り除く", () => {
    expect(stripCustomEmoji("see :blobcat:// comment")).toBe("see // comment");
  });

  test("CRLF の行末の絵文字は前の空白ごと取り除く", () => {
    expect(stripCustomEmoji("行末 :blob:\r\n次")).toBe("行末\r\n次");
  });

  test("URL の直後に全角の句読点を挟んだ絵文字も取り除く", () => {
    expect(stripCustomEmoji("https://example.com/page、:blobcat: すごい")).toBe(
      "https://example.com/page、 すごい",
    );
  });

  test.each([
    ..."_\u200C\u200D\uA67E\u05BE\u05F3\u05F4\uFF5E\u301C\u309B\u309C\u30A0\u30FB\u3003\u0F0B\u0F0C\u00B7\uF870",
  ])("X がタグの途中に置ける %j の後ろの絵文字も、詰めずに区切る", (char) => {
    expect(stripCustomEmoji(`#ねこ${char}:x:かわいい`)).toBe(
      `#ねこ${char} かわいい`,
    );
  });

  test("空白のない長い語に絵文字が並んでも時間がかからない", () => {
    // 語を切り出してから長さを確かめると、絵文字ごとに長い語を切り出し、長さの二乗の時間がかかる
    // 本文の上限を上げたインスタンスを想定した長さ。修正前は約 400 ms かかっていた
    const text = "a.com:b:".repeat(6000);
    const started = performance.now();
    stripCustomEmoji(text);
    expect(performance.now() - started).toBeLessThan(150);
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

  test.each([
    // 詰めると、URL でなくなったり、URL が後ろの本文を取り込んだりするので区切る
    ["https://a.com:blob:x", "https://a.com x"],
    ["a.com:blob:b.com", "a.com b.com"],
    ["https://a.com:blob:とmisskey.io", "https://a.com とmisskey.io"],
    // 読み方が変わらなければ詰める
    ["見てね:blob:https://a.com", "見てねhttps://a.com"],
    // findUrls が URL にしないリンク先のスキームは、絵文字とみなさない
    ["URL:https://foo.zzz/x", "URL:https://foo.zzz/x"],
    // BOM の直後の URL は X が URL にしないので区切る
    ["\uFEFF:x:https://c.com", "\uFEFF https://c.com"],
    // 手前が全角の空白なら、すでに区切られている
    ["foo　:blobcat:あb.com", "foo　あb.com"],
    // 同じ語の中の絵文字は、まとめて詰めたときの読み方も確かめる
    ["see https://a.com:a:.:b:jp now", "see https://a.com . jp now"],
    ["https://a:x:.:y:com/@user", "https://a . com/@user"],
    // X がリンクにする国際化ドメインの URL の中は書き換えない
    ["https://例え.jp/a:b:c", "https://例え.jp/a:b:c"],
    ["リンク:-https://例え.jp/page", "リンク:-https://例え.jp/page"],
    // 手前のタグに詰めると、別のタグに変わるか、X がタグとして扱わなくなる
    ["#猫:blobcat:かわいい", "#猫 かわいい"],
    ["＃猫:blobcat:かわいい", "＃猫 かわいい"],
    ["#イベント2024:blob:楽しい", "#イベント2024 楽しい"],
    ["#𠮷:x:野家", "#𠮷 野家"],
    ["#हिंदी:x:भाषा", "#हिंदी भाषा"],
    // X はタグの途中に ・ や 〜 も置ける
    ["#ねこ〜:neko:かわいい", "#ねこ〜 かわいい"],
    ["#ポケモン・:pika:ゲーム", "#ポケモン・ ゲーム"],
    ["#お知らせ:blob:https://example.com", "#お知らせ https://example.com"],
    ["$TSLA:x:misskey", "$TSLA misskey"],
    ["$BRK.A:x:あ", "$BRK.A あ"],
    // 詰めると X がハッシュタグとして扱わなくなる
    ["見て:blob:#tag", "見て #tag"],
    ["https://a.com:blob:＃tag", "https://a.com ＃tag"],
  ])("%j の絵文字を取り除いても、X の読み方を変えない", (input, expected) => {
    expect(stripCustomEmoji(input)).toBe(expected);
  });

  test.each([
    ["今日はmisskey.ioで遊んだ:blobcat:".repeat(100)],
    [".:x:".repeat(750)],
    ["@a.:x:".repeat(500)],
  ])("空白のない長い本文に絵文字が並んでも時間がかからない", (text) => {
    const started = performance.now();
    defuseMentions(stripCustomEmoji(text));
    // 確かめる文字数の上限がないと、数百 ms かかる
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("確かめる文字数の上限を使い切った後は、確かめずに区切る", () => {
    const text = `${"あ:x:".repeat(600)}https://a.com:blob:x`;
    expect(stripCustomEmoji(text).endsWith("https://a.com x")).toBe(true);
  });

  test(". のない長い行では、上限を使わずに絵文字を詰める", () => {
    const line =
      "今日はとても良い天気でしたね:blobcat:散歩に行きました:ablobcatnod:";
    expect(stripCustomEmoji(line.repeat(60))).toBe(
      "今日はとても良い天気でしたね散歩に行きました".repeat(60),
    );
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

  test("ゼロ幅スペースで X の URL の範囲が変われば、変わらなくなるまで無害化する", () => {
    // @ の直後にゼロ幅スペースを挟むと、X は alice.com から読み、クエリの URL を取り込む
    expect(defuseMentions("@alice.com?u=https://x.com/@bob")).toBe(
      "@\u200Balice.com?u=https://x.com/@\u200Bbob",
    );
    // 変わらなくなったら止め、ほかの URL の中の @ は無害化しない
    expect(
      defuseMentions(
        "@alice.com?u=https://x.com/@bob https://misskey.io/@carol",
      ),
    ).toBe(
      "@\u200Balice.com?u=https://x.com/@\u200Bbob https://misskey.io/@carol",
    );
  });

  test("無害化で X の URL の範囲が変わり続けても、時間をかけずにすべて無害化する", () => {
    const text = "@a.co/жhttps://b.co?=".repeat(143);
    const started = performance.now();
    const out = defuseMentions(text);
    expect(performance.now() - started).toBeLessThan(100);
    expect(out).not.toMatch(/@(?!\u200B)/);
  });

  test("メールアドレスは変更しない", () => {
    expect(defuseMentions("mail: a@example.com")).toBe("mail: a@example.com");
  });

  test("URL の中の @ は変えない", () => {
    expect(defuseMentions("見て https://misskey.io/@alice/123 と @bob")).toBe(
      "見て https://misskey.io/@alice/123 と @\u200Bbob",
    );
    for (const url of [
      "https://a.com/?q=%E3&u=@alice",
      "https://a.com/~alice/@bob",
      "https://a.com/a&b/@alice",
      "https://t.co/abc?u=@alice",
      "https://a.xn--p1ai/@alice",
      "https://a.XN--P1AI/@alice",
      // パスとクエリに置ける記号
      "https://a.com/a–b/@alice",
      "https://a.com/a,b/@alice",
      "https://a.com/a;b/@alice",
      "https://a.com/a*b/@alice",
      "https://a.com/a|b/@alice",
      "https://a.com/x=(@bob)",
      "https://a.com/a#(@bob)",
      "https://a.com/?a=|b&u=@alice",
      "https://a.com/?a=1,2&u=@alice",
      "https://a.com/?a=*&u=@alice",
      "https://a.com/?a=$&u=@alice",
      "https://a.com/?a=?&u=@alice",
    ]) {
      expect(defuseMentions(url)).toBe(url);
    }
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
    // X が URL にしないかたまりの中の URL も、X と同じく URL とみなさない
    ["$https://misskey.io/?r=https://a.jp/@alice", "jp/@\u200Balice"],
    ["example.com?u=https://x.com/@bob", "com/@\u200Bbob"],
    // X は t.co の URL をスラッグまでにする
    ["https://t.co/abc/@alice", "abc/@\u200Balice"],
    ["https://T.CO/abc/@alice", "abc/@\u200Balice"],
    // BOM と同じく、U+FFFE / U+FFFF の直後の URL も X は URL にしない
    ["\uFFFEhttps://a.com/@bob", "com/@\u200Bbob"],
    ["\uFFFFhttps://a.com/@bob", "com/@\u200Bbob"],
    // X は括弧の入れ子を 1 段までしか URL に含めない
    ["https://a.com/a(b(c(d)))@alice", ")))@\u200Balice"],
    // 一覧にない TLD は X と同じくドメインとして読まず、後ろのかたまりの中の URL も URL とみなさない
    ["a.zzz/xあ.com/https://e.com/@user", "com/@\u200Buser"],
    ["a.zz/xyzあ.com?u=https://b.com/@user", "com/@\u200Buser"],
    // t.co の URL を縮めた後も、走査はスラッグの後ろを消費したまま次を探す
    ["https://t.co/abc/:https://misskey.io/@alice", "io/@\u200Balice"],
    ["＃https://a.com/@alice", "com/@\u200Balice"],
    // ホストが長すぎて X が URL にしないかたまりは、TLD を一覧の順に試して消費する
    [
      `https://${"a".repeat(64)}.嘉里大酒店/?u=https://b.com/@alice`,
      "com/@\u200Balice",
    ],
  ])("%s の X で URL にならない部分のメンションは無害化する", (input, tail) => {
    expect(defuseMentions(input).endsWith(tail)).toBe(true);
  });

  test.each([
    ["＠alice さん", "＠\u200Balice さん"],
    ["こんにちは＠bob", "こんにちは＠\u200Bbob"],
    ["RT@bob", "RT@\u200Bbob"],
    // 続く RT の後ろの記号も無害化する。最初の記号だけでは、X が後ろをメンションにする
    ["RT@RT@alice", "RT@\u200BRT@\u200Balice"],
    ["RT＠RT＠alice", "RT＠\u200BRT＠\u200Balice"],
    ["RT:@bob", "RT:@\u200Bbob"],
    ["見て RT@bob", "見て RT@\u200Bbob"],
    ["rt@bob", "rt@\u200Bbob"],
    ["Rt@bob", "Rt@\u200Bbob"],
    ["rT＠bob", "rT＠\u200Bbob"],
    // _ や数字で始まるユーザー名
    ["@_alice", "@\u200B_alice"],
    ["@1alice", "@\u200B1alice"],
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
    ["https://ex.com/a.?x=@alice", "?x=@\u200Balice"],
    ["https://ex.com/a&?x=@alice", "?x=@\u200Balice"],
    ["https://ex.com/()@alice", "()@\u200Balice"],
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

  test("クエリに空の角括弧がある URL の中の @ は変えない", () => {
    const url = "https://example.com/?ids[]=1&x=@alice";
    expect(defuseMentions(url)).toBe(url);
  });

  test("パスの括弧の中に ? がある URL では、括弧の後のメンションを無害化する", () => {
    expect(defuseMentions("https://ex.com/x(a?b)@alice")).toBe(
      "https://ex.com/x(a?b)@\u200Balice",
    );
  });

  test("パスの末尾に置けない文字の後の括弧の中のメンションは無害化する", () => {
    expect(defuseMentions("https://ex.com/a](@alice)")).toBe(
      "https://ex.com/a](@\u200Balice)",
    );
  });

  test("括弧で囲んだ URL の直後のメンションは無害化する", () => {
    expect(defuseMentions("(https://example.com)@alice")).toBe(
      "(https://example.com)@\u200Balice",
    );
  });

  // 全角の ＠ は URL に含まれないので、直前の文字が URL の末尾でも X はメンションとして扱う
  test.each([
    [
      "見て https://example.com/＠alice",
      "見て https://example.com/＠\u200Balice",
    ],
    ["https://misskey.io/＠alice", "https://misskey.io/＠\u200Balice"],
    ["https://example.com/a-＠alice", "https://example.com/a-＠\u200Balice"],
    ["https://example.com/RT＠alice", "https://example.com/RT＠\u200Balice"],
  ])(
    "%s の URL の直後の全角 ＠ のメンションは無害化する",
    (input, expected) => {
      expect(defuseMentions(input)).toBe(expected);
    },
  );
});

describe("buildPost", () => {
  const link = "https://misskey.io/notes/a1b2c3";

  test("attachSensitive ならセンシティブ指定の画像も添付する", () => {
    const files = [
      {
        id: "1",
        type: "image/png",
        url: "https://f/1.png",
        isSensitive: true,
      },
    ];
    const post = buildPost(
      makeNote({ files }),
      makeConfig({ attachSensitive: true }),
    );
    expect(post.imageUrls).toEqual(["https://f/1.png"]);
  });

  test.each([
    ["\uFEFFa.com?https://b.com/@u"],
    [":e:\uFEFFa.com?https://b.com/@u"],
  ])("先頭の BOM が消えても、%j のメンションを無害化する", (text) => {
    // BOM の後ろでは URL とみなすが、BOM を取り除くと X はドメインのクエリとして読む
    const post = buildPost(makeNote({ text }), makeConfig());
    expect(post.text).toBe("a.com?https://b.com/@\u200Bu");
  });

  test("MFM の記号を取り除いて合成された TLD の、クエリの中のメンションも無害化する", () => {
    // `ク` と濁点がつながって `グーグル` になり、X はクエリごとドメインとして読む
    const post = buildPost(
      makeNote({ text: "a.ク<b>\u3099</b>ーグル?u=https://b.com/@bob" }),
      makeConfig(),
    );
    expect(post.text).toBe("a.グーグル?u=https://b.com/@\u200Bbob");
  });

  test("NFC に正規化すると URL でなくなる URL の中のメンションも無害化する", () => {
    // ケルビン記号（U+212A）は NFC で K になり、X は直後の URL を URL とみなさない
    const post = buildPost(
      makeNote({ text: "\u212Ahttps://x.com/@bob" }),
      makeConfig(),
    );
    expect(post.text).toBe("Khttps://x.com/@\u200Bbob");
  });

  test.each([
    ["見て\u212A:x:https://a.com", "見てK https://a.com"],
    ["[l](https://a.com)\u212A", "l https://a.com K"],
    ["300\u212A[ ](https://a.com/x)", "300K https://a.com/x"],
    // 詰めると、X のリンク先が別人のプロフィール（@aliceK）に変わる
    [
      "[記事](https://misskey.io/@alice)\u212A",
      "記事 https://misskey.io/@alice K",
    ],
    // 後ろの結合文字が URL の最後の文字と合成されると、X のリンク先が変わる
    ["[l](https://misskey.io)\u0301", "l https://misskey.io \u0301"],
    ["https://misskey.io:x:\u0301", "https://misskey.io \u0301"],
  ])("%j の区切りは、NFC に正規化した本文で決める", (text, expected) => {
    const post = buildPost(makeNote({ text }), makeConfig());
    expect(post.text).toBe(expected);
  });

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

  test("リンク記法の直後の絵文字を取り除いても、URL を後ろの本文につなげない", () => {
    const post = buildPost(
      makeNote({ text: "[l](https://a.com):blob:x" }),
      config,
    );
    expect(post.text).toBe("l https://a.com x");
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

  test.each(["always", "truncated"] as const)(
    "X が URL とみなすリンクは 23 と数え、本文を上限まで残す（%s）",
    (appendLink) => {
      const post = buildPost(
        makeNote({ text: "あ".repeat(300) }),
        makeConfig({ appendLink }),
        link,
      );
      // 本文 254 + … 2 + 改行 1 + リンク 23 = 280
      expect(post.text).toBe(`${"あ".repeat(127)}…\n${link}`);
    },
  );

  test.each([
    ["always", "http://localhost:3000/notes/abc"],
    ["truncated", "http://localhost:3000/notes/abc"],
    ["always", "https://misskey.hogehoge/notes/abc"],
  ] as const)(
    "X が URL とみなさないリンクも、文字数を数えて上限に収める（%s, %s）",
    (appendLink, url) => {
      const post = buildPost(
        makeNote({ text: "あ".repeat(300) }),
        makeConfig({ appendLink }),
        url,
      );
      expect(post.truncated).toBe(true);
      expect(post.text.endsWith(`\n${url}`)).toBe(true);
      expect(weightedLength(post.text)).toBeLessThanOrEqual(
        MAX_WEIGHTED_LENGTH,
      );
    },
  );

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
