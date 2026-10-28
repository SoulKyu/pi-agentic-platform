import { describe, expect, it } from "vitest";
import { insertAt, knowledgeRequest, MAX_QUOTE, placeToolbar, quoteOf } from "./quote.vm.ts";

describe("quoteOf", () => {
  it('quoteOf prefixes each line with "> ", turns empty lines into ">" and ends with an empty line', () => {
    expect(quoteOf("one\n\ntwo")).toBe("> one\n>\n> two\n\n");
  });

  it("hidden characters go and the text is clipped at 20 000", () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    expect(quoteOf(`a${zeroWidth}b`)).toBe("> ab\n\n");
    const long = quoteOf("x".repeat(MAX_QUOTE + 500));
    expect(long).toBe(`> ${"x".repeat(MAX_QUOTE)}\n\n`);
  });
});

describe("quoteOf at the limit", () => {
  it("never splits a surrogate pair at 20 000", () => {
    const pair = String.fromCodePoint(0x1f600);
    const quoted = quoteOf(`${"x".repeat(MAX_QUOTE - 1)}${pair}tail`);
    expect(quoted).toBe(`> ${"x".repeat(MAX_QUOTE - 1)}\n\n`);
    const whole = quoteOf(`${"x".repeat(MAX_QUOTE - 2)}${pair}tail`);
    expect(whole).toBe(`> ${"x".repeat(MAX_QUOTE - 2)}${pair}\n\n`);
  });
});

describe("insertAt", () => {
  it("insertAt puts a new line first when the caret is mid-line and returns the caret after the insert", () => {
    expect(insertAt("hello world", 5, "> q\n\n")).toEqual({
      text: "hello\n> q\n\n world",
      caret: 5 + 1 + 5,
    });
    expect(insertAt("hello\n", 6, "> q\n\n")).toEqual({ text: "hello\n> q\n\n", caret: 11 });
    expect(insertAt("", 0, "> q\n\n")).toEqual({ text: "> q\n\n", caret: 5 });
  });
});

describe("knowledgeRequest", () => {
  it("knowledgeRequest puts the fixed line, a blank line, then the quote", () => {
    expect(knowledgeRequest("Record it.", "> q\n\n")).toBe("Record it.\n\n> q\n\n");
  });
});

describe("placeToolbar", () => {
  const view = { width: 1000, height: 800 };
  it("sits above the selection, centred and clamped into the viewport", () => {
    const rect = { left: 400, right: 600, top: 300, bottom: 320 };
    const above = placeToolbar(rect, view);
    expect(above.top).toBeLessThan(300);
    expect(placeToolbar({ ...rect, left: 0, right: 10 }, view).left).toBeGreaterThanOrEqual(8);
    const right = placeToolbar({ ...rect, left: 990, right: 1000 }, view);
    expect(right.left).toBeLessThanOrEqual(1000 - 8);
  });
  it("clamps by the bar's real width, a wide one included", () => {
    const rect = { left: 900, right: 990, top: 300, bottom: 320 };
    const wide = { width: 420, height: 44 };
    const placed = placeToolbar(rect, view, wide);
    expect(placed.left + wide.width).toBeLessThanOrEqual(1000 - 8);
    expect(placed.left).toBeGreaterThanOrEqual(8);
  });
  it("goes below the selection when there is no room above", () => {
    const placed = placeToolbar({ left: 400, right: 600, top: 10, bottom: 30 }, view);
    expect(placed.top).toBeGreaterThan(30);
  });
});
