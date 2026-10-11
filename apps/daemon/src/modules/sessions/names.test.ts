import { describe, expect, it } from "vitest";
import { nameOf } from "./names.ts";

describe("nameOf (M2R92)", () => {
  it.each([
    ["  Fix   the\tlogin  ", "Fix the login"],
    ["\u202Eevil\u0007 name", "evil name"],
    ["ab\u200Bcd", "abcd"],
    ["ab\uFEFFcd", "abcd"],
    ["\uFEFFab", "ab"],
    ["a \u0007 b", "a b"],
    ["a\u0085b", "a b"],
    ["a\u2028b\u2029c", "a b c"],
    ["line one\nline two", "line one line two"],
    ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["❤\uFE0F ok ❤\uFE0E", "❤\uFE0F ok ❤\uFE0E"],
    ["\u{1F3F4}\u{E0067}\u{E007F}", "\u{1F3F4}"],
    ["\u200D \uFE0F", null],
    ["", null],
    [" \n ", null],
    ["\u202E\u200B", null],
    [42, null],
    [undefined, null],
    [null, null],
    ["\u{1F600}".repeat(300), "\u{1F600}".repeat(256)],
    ["x".repeat(255) + " tail", "x".repeat(255)],
    ["\ud83d" + "x", "�x"],
  ])("clips %j to %j", (raw, expected) => {
    expect(nameOf(raw)).toBe(expected);
  });

  it("never cuts a surrogate pair, and never returns more than 256 code points", () => {
    for (const filler of ["", "a", "ab"]) {
      const cut = nameOf(`${filler}${"😀".repeat(300)}`) ?? "";
      expect([...cut].length).toBeLessThanOrEqual(256);
      expect(() => encodeURIComponent(cut)).not.toThrow();
    }
  });
});
