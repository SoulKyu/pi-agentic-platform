import { describe, expect, it } from "vitest";
import { cleanLabel, cutUnits, LONE_SURROGATE, MAX_ID_CHARS } from "./text.ts";

// With the u flag, \p{Surrogate} matches only a half without its other half.
const hasLoneHalf = (text: string): boolean => /\p{Surrogate}/u.test(text);

describe("cutUnits", () => {
  it("leaves a text that fits as it is", () => {
    expect(cutUnits("abc", 3)).toBe("abc");
    expect(cutUnits("abc", 3, "…")).toBe("abc");
  });

  it("cuts to `max` UTF-16 units, the marker included", () => {
    expect(cutUnits("abcdef", 4)).toBe("abcd");
    expect(cutUnits("abcdef", 4, "…")).toBe("abc…");
    expect(cutUnits("abcdef", 1, "…")).toBe("…");
  });

  it("never ends on the first half of a surrogate pair", () => {
    const text = "ab\u{1F600}cd"; // a, b, \ud83d, \ude00, c, d
    expect(cutUnits(text, 3)).toBe("ab");
    expect(cutUnits(text, 4)).toBe("ab\u{1F600}");
    expect(cutUnits(text, 4, "…")).toBe("ab…");
    for (let max = 0; max <= 20; max++)
      expect(hasLoneHalf(cutUnits("\u{1F600}".repeat(10), max))).toBe(false);
  });
});

describe("LONE_SURROGATE", () => {
  it("finds halves without their other half, never a whole pair", () => {
    expect("a\ud800b".replace(LONE_SURROGATE, "\uFFFD")).toBe("a\uFFFDb");
    expect("a\udc00b".replace(LONE_SURROGATE, "\uFFFD")).toBe("a\uFFFDb");
    expect("a\u{1F600}b".replace(LONE_SURROGATE, "\uFFFD")).toBe("a\u{1F600}b");
  });
});

describe("cleanLabel", () => {
  it("removes control and bidi characters, joins whitespace, cuts by code points, trims", () => {
    expect(cleanLabel("a\u202Eb  c\nd\u{1F600}\u{1F600}", 5)).toBe("ab c");
    expect(cleanLabel("  x\u0000y\t", 10)).toBe("xy");
    expect(cleanLabel("\u{1F600}\u{1F600}\u{1F600}", 2)).toBe("\u{1F600}\u{1F600}");
  });

  it("is null for what holds nothing to show", () => {
    expect(cleanLabel(42, 10)).toBeNull();
    expect(cleanLabel("", 10)).toBeNull();
    expect(cleanLabel("\u200B\u202E \n", 10)).toBeNull();
    expect(cleanLabel("\u200D \uFE0F", 10)).toBeNull();
  });

  it("keeps the joiner of an emoji sequence", () => {
    expect(cleanLabel("\u{1F469}\u200D\u{1F4BB} dev", 10)).toBe("\u{1F469}\u200D\u{1F4BB} dev");
  });
});

it("MAX_ID_CHARS is the contracts' id bound", () => {
  expect(MAX_ID_CHARS).toBe(128);
});
