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
});

describe("stripCustomEmoji", () => {
  test(":name: を取り除き、余分な空白を詰める", () => {
    expect(stripCustomEmoji("やった :blobcat_yay: ね")).toBe("やった ね");
  });

  test("時刻のような数字だけの並びは残す", () => {
    expect(stripCustomEmoji("12:30:45 に集合")).toBe("12:30:45 に集合");
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
});

describe("buildPost", () => {
  const link = "https://misskey.example/notes/a1b2c3";

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

  test("truncated 設定では切り詰めたときだけリンクを付ける", () => {
    const c = makeConfig({ appendLink: "truncated" });
    expect(buildPost(makeNote({ text: "短い" }), c, link).text).toBe("短い");
    const long = buildPost(makeNote({ text: "あ".repeat(300) }), c, link);
    expect(long.text.endsWith(`…\n${link}`)).toBe(true);
    expect(weightedLength(long.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });

  test("always 設定では常にリンクを付ける", () => {
    const c = makeConfig({ appendLink: "always" });
    expect(buildPost(makeNote({ text: "短い" }), c, link).text).toBe(
      `短い\n${link}`,
    );
  });
});
