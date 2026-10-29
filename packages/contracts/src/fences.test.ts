import { describe, expect, it } from "vitest";
import { fenceIndexAt, scanFences } from "./fences.ts";

describe("scanFences", () => {
  it("finds backtick and tilde fences with their lower-cased language", () => {
    const text = "intro\n```HTML extra\n<p>a</p>\n```\n\n~~~js\nlet a;\n~~~\n";
    expect(scanFences(text)).toEqual([
      { start: 6, lang: "html", body: "<p>a</p>" },
      { start: text.indexOf("~~~js"), lang: "js", body: "let a;" },
    ]);
  });

  it("closes only with the same character and at least the same length", () => {
    expect(scanFences("````html\na\n```\nb\n````\n")).toEqual([
      { start: 0, lang: "html", body: "a\n```\nb" },
    ]);
    expect(scanFences("```html\na\n~~~\nb\n```\n")).toEqual([{ start: 0, lang: "html", body: "a\n~~~\nb" }]);
    expect(scanFences("```html\na\n``` x\nb\n```\n")).toEqual([
      { start: 0, lang: "html", body: "a\n``` x\nb" },
    ]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(scanFences("```html\na\nb")).toEqual([{ start: 0, lang: "html", body: "a\nb" }]);
  });

  it("allows up to 3 spaces of indent and strips that much from the body", () => {
    expect(scanFences("  ```html\n  a\n    b\n x\n  ```\n")).toEqual([
      { start: 0, lang: "html", body: "a\n  b\nx" },
    ]);
    expect(scanFences("    ```html\na\n    ```\n")).toEqual([]);
  });

  it("is not top-level inside a block quote or with a backtick in a backtick info", () => {
    expect(scanFences("> ```html\n> a\n> ```\n")).toEqual([]);
    expect(scanFences("```a`b\nx\n")).toEqual([]);
    expect(scanFences("``\nx\n``\n")).toEqual([]);
    expect(scanFences("```a`b\nx\n```\n")).toEqual([{ start: 9, lang: "", body: "" }]);
  });

  it("gives an empty lang when the info is empty", () => {
    expect(scanFences("```\nx\n```")).toEqual([{ start: 0, lang: "", body: "x" }]);
  });
});

describe("fenceIndexAt", () => {
  const text = "a\n```html\nx\n```\nmid\n~~~css\ny\n~~~\nend\n";
  const second = text.indexOf("~~~css");
  it("gives the index of the fence whose opening line holds the offset", () => {
    expect(fenceIndexAt(text, 2)).toBe(0);
    expect(fenceIndexAt(text, 6)).toBe(0);
    expect(fenceIndexAt(text, second)).toBe(1);
    expect(fenceIndexAt(text, second + 3)).toBe(1);
  });
  it("is null in a body and between fences", () => {
    expect(fenceIndexAt(text, text.indexOf("x\n"))).toBeNull();
    expect(fenceIndexAt(text, text.indexOf("mid"))).toBeNull();
    expect(fenceIndexAt(text, 0)).toBeNull();
  });
});
