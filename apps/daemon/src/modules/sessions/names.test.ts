import { describe, expect, it } from "vitest";
import { nameOf } from "./names.ts";

describe("nameOf (M2R92)", () => {
  it.each([
    ["  Fix   the\tlogin  ", "Fix the login"],
    ["‮evil\u0007 name", "evil name"],
    ["ab​cd", "abcd"],
    ["a \u0007 b", "a b"],
    ["line one\nline two", "line one line two"],
    ["", null],
    [" \n ", null],
    ["‮​", null],
    [42, null],
    [undefined, null],
    [null, null],
    ["😀".repeat(300), "😀".repeat(256)],
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
