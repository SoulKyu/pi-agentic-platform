import { describe, expect, it } from "vitest";
import { MAX_SPANS, parseAnsi, plainText } from "./ansi.ts";

const plain = { tone: null, bold: false, faint: false, italic: false, underline: false };

describe("ANSI colours in extension text (owner C2)", () => {
  it.each([
    [30, "dim"],
    [31, "error"],
    [32, "ok"],
    [33, "you"],
    [34, "agent"],
    [35, "attention"],
    [36, "agent"],
    [37, "text"],
    [90, "dim"],
    [91, "error"],
    [92, "ok"],
    [93, "you"],
    [94, "agent"],
    [95, "attention"],
    [96, "agent"],
    [97, "text"],
  ])("maps SGR %i to the %s tone", (code, tone) => {
    expect(parseAnsi(`\u001b[${code}mx\u001b[39my`)).toEqual([
      { ...plain, text: "x", tone },
      { ...plain, text: "y" },
    ]);
  });

  it("keeps bold, dim, italic and underline, and resets them", () => {
    expect(parseAnsi("\u001b[1;3ma\u001b[22;2mb\u001b[0;4mc")).toEqual([
      { ...plain, text: "a", bold: true, italic: true },
      { ...plain, text: "b", faint: true, italic: true },
      { ...plain, text: "c", underline: true },
    ]);
  });

  it("ignores backgrounds, inverse, 256-colour and truecolor, and keeps the text", () => {
    expect(
      parseAnsi("\u001b[31mred\u001b[38;5;196m still red\u001b[48;2;1;2;3m\u001b[7m\u001b[44m!"),
    ).toEqual([
      { ...plain, text: "red", tone: "error" },
      { ...plain, text: " still red", tone: "error" },
      { ...plain, text: "!", tone: "error" },
    ]);
  });

  it("drops other escapes, bidi and control characters, keeps tabs (M2-RT-42)", () => {
    expect(
      plainText("\u001b]8;;https://x\u0007link\u001b]8;;\u0007 \u001b_pi:c\u0007\u001b[2K→ ✓‮\u0007\tend"),
    ).toBe("link → ✓\tend");
  });

  it("removes every bidi control (U+202A-202E, U+2066-2069, U+200E/F, U+061C) and C0/C1 controls", () => {
    const bidi = "‪‫‬‭‮⁦⁧⁨⁩‎‏؜";
    expect(plainText(`a${bidi}b\u0000\u0008\u000a\u000d\u007f\u0085\u009bc`)).toBe("abc");
  });

  it("does not read a private or malformed SGR as a reset or a colour", () => {
    expect(parseAnsi("\u001b[31mred\u001b[?25mstill\u001b[3:4mx\u001b[31;1:2my")).toEqual([
      { ...plain, text: "red", tone: "error" },
      { ...plain, text: "still", tone: "error" },
      { ...plain, text: "x", tone: "error" },
      { ...plain, text: "y", tone: "error" },
    ]);
  });

  it("caps the spans of one line; what follows is one plain span with all its text", () => {
    const line = Array.from({ length: 300 }, (_, i) => `\u001b[3${i % 8}m${i % 10}`).join("");
    const spans = parseAnsi(line);
    expect(spans).toHaveLength(MAX_SPANS);
    expect(spans.at(-1)).toMatchObject({ tone: null, bold: false });
    expect(spans.map((span) => span.text).join("")).toBe(plainText(line));
    expect(plainText(line)).toHaveLength(300);
  });

  it("starts every call plain, so a style left open by a cut line does not leak into the next one", () => {
    expect(parseAnsi("\u001b[31mopen")).toEqual([{ ...plain, text: "open", tone: "error" }]);
    expect(parseAnsi("next")).toEqual([{ ...plain, text: "next" }]);
  });

  it("removes a lone ESC and keeps the characters around it", () => {
    expect(plainText("a\u001bb")).toBe("ab");
    expect(plainText("a\u001b")).toBe("a");
    expect(plainText("\u001b\u001b[31mx")).toBe("x");
  });

  it("drops a CSI with intermediate bytes instead of reading it as SGR", () => {
    expect(parseAnsi("\u001b[31 mred")).toEqual([{ ...plain, text: "red" }]);
  });
});
