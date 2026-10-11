import { describe, expect, it } from "vitest";
import { boundLines } from "./ui-lines.ts";

const LIMITS = { lines: 3, lineChars: 10, bytes: 1000 };

describe("boundLines: extension text on its way to the browser", () => {
  it("keeps SGR colour, bold, dim, italic and underline", () => {
    const text = "\u001b[1;31mA\u001b[0m\u001b[2mB\u001b[22m\u001b[3mC\u001b[4mD\u001b[90mE\u001b[39m";
    expect(boundLines([text], { ...LIMITS, lineChars: 100 })).toEqual([text]);
  });

  it.each([
    ["cursor move", "a\u001b[2J\u001b[1;1Hb", "ab"],
    ["private mode", "a\u001b[?1049hb", "ab"],
    ["CSI with intermediate", "a\u001b[0 qb", "ab"],
    ["OSC title, BEL terminated", "a\u001b]0;pwned\u0007b", "ab"],
    ["OSC hyperlink, ST terminated", "a\u001b]8;;https://x.test\u001b\\link\u001b]8;;\u001b\\b", "alinkb"],
    ["DCS", "a\u001bPq#0;2;0;0;0\u001b\\b", "ab"],
    ["APC", "a\u001b_Gi=1;AAAA\u001b\\b", "ab"],
    ["unterminated OSC eats the rest of the line", "a\u001b]0;never ends", "a"],
    ["two-byte escape", "a\u001bcb\u001b7c", "abc"],
    ["BEL, backspace, CR, LF, NUL, DEL", "a\u0007\b\r\n\u0000\u007fb", "ab"],
    ["C1 controls", "a\u009b31m\u009d0;t\u0007b", "a31m0;tb"],
    ["lone ESC", "a\u001b", "a"],
  ])("strips %s", (_name, input, expected) => {
    expect(boundLines([input], { ...LIMITS, lineChars: 100 })).toEqual([expected]);
  });

  it("keeps tabs", () => {
    expect(boundLines(["a\tb"], LIMITS)).toEqual(["a\tb"]);
  });

  it("cuts the line count and the line length, and never leaves half a sequence or half a character", () => {
    expect(boundLines(["a", "b", "c", "d"], LIMITS)).toEqual(["a", "b", "c"]);
    expect(boundLines(["abcdefghijklmnop"], LIMITS)).toEqual(["abcdefghij"]);
    expect(boundLines(["abcdefgh\u001b[31mXYZ"], LIMITS)).toEqual(["abcdefgh"]);
    expect(boundLines(["abcdefg\u001b[31mXYZ"], LIMITS)).toEqual(["abcdefg"]);
    expect(boundLines(["abcdefghi\u{1F600}"], LIMITS)).toEqual(["abcdefghi"]);
  });

  it("stops at the byte budget of the whole record", () => {
    const out = boundLines(["x".repeat(10), "y".repeat(10), "z".repeat(10)], {
      lines: 3,
      lineChars: 10,
      bytes: 25,
    });
    expect(out).toEqual(["x".repeat(10), "y".repeat(10)]);
  });

  it("turns non-strings into empty lines", () => {
    expect(boundLines(["a", 5 as never, undefined as never], LIMITS)).toEqual(["a", "", ""]);
  });
});
