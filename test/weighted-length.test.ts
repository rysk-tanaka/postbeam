import { describe, expect, test } from "vitest";
import {
  MAX_WEIGHTED_LENGTH,
  truncateWeighted,
  weightedLength,
} from "../src/weighted-length";

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

  test("URL は途中で切らずにまるごと落とす", () => {
    const text = `${"a".repeat(270)} https://example.com/page`;
    const r = truncateWeighted(text);
    expect(r.text).not.toContain("https://");
    expect(weightedLength(r.text)).toBeLessThanOrEqual(MAX_WEIGHTED_LENGTH);
  });
});
