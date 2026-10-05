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
