import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

const base = { MISSKEY_HOOK_SECRET: "s" };

describe("loadConfig の真偽値", () => {
  test.each(["true", "1", "yes", " TRUE "])("%j は true", (value) => {
    expect(loadConfig({ ...base, INCLUDE_REPLIES: value }).includeReplies).toBe(
      true,
    );
  });

  test.each(["false", "0", "no", "No"])("%j は false", (value) => {
    expect(
      loadConfig({ ...base, STRIP_CUSTOM_EMOJI: value }).stripCustomEmoji,
    ).toBe(false);
  });

  test.each([undefined, "", "  "])("%j は既定値", (value) => {
    const config = loadConfig({ ...base, STRIP_CUSTOM_EMOJI: value });
    expect(config.stripCustomEmoji).toBe(true);
  });

  test("列挙値も、空白だけなら既定値", () => {
    expect(loadConfig({ ...base, APPEND_LINK: "  " }).appendLink).toBe("never");
  });

  test.each(["", " , "])("VISIBILITIES が空（%j）なら ConfigError", (value) => {
    expect(() => loadConfig({ ...base, VISIBILITIES: value })).toThrow(
      ConfigError,
    );
  });

  test("VISIBILITIES に未知の値があれば ConfigError", () => {
    expect(() => loadConfig({ ...base, VISIBILITIES: "pubic,home" })).toThrow(
      ConfigError,
    );
  });

  test("VISIBILITIES は既知の値ならすべて受け付ける", () => {
    const config = loadConfig({
      ...base,
      VISIBILITIES: "public, Home, followers, specified",
    });
    expect([...config.visibilities]).toEqual([
      "public",
      "home",
      "followers",
      "specified",
    ]);
  });

  test("EXCLUDE_TAGS は NFKC に正規化し、全角の ＃ も取り除く", () => {
    const config = loadConfig({ ...base, EXCLUDE_TAGS: "ﾃｽﾄ, ＮＯＸ, ＃Foo" });
    expect([...config.excludeTags]).toEqual(["テスト", "nox", "foo"]);
  });

  test.each([
    ["＃　nox, # foo", ["nox", "foo"]],
    ["nox，テスト", ["nox", "テスト"]],
  ])(
    "EXCLUDE_TAGS の # の後ろの空白と全角のカンマも扱う（%j）",
    (value, expected) => {
      const config = loadConfig({ ...base, EXCLUDE_TAGS: value });
      expect([...config.excludeTags]).toEqual(expected);
    },
  );

  test("VISIBILITIES には NFKC の正規化をかけない", () => {
    expect(() => loadConfig({ ...base, VISIBILITIES: "ｐｕｂｌｉｃ" })).toThrow(
      ConfigError,
    );
  });

  test.each([
    ["POSTER", "twitter"],
    ["CW_MODE", "hide"],
    ["APPEND_LINK", "alway"],
  ])("列挙値 %s の不正な値（%j）は ConfigError", (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(ConfigError);
  });

  test("不正な値は ConfigError", () => {
    expect(() => loadConfig({ ...base, ATTACH_SENSITIVE: "ture" })).toThrow(
      ConfigError,
    );
  });
});
