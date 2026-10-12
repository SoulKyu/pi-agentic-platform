import { describe, expect, it } from "vitest";
import { splitBlocks } from "./streaming-blocks.ts";

describe("splitBlocks (M4R113)", () => {
  it("splits at blank lines outside code fences", () => {
    expect(splitBlocks("a\nb\n\nc\n\n\nd")).toEqual(["a\nb", "c", "d"]);
    expect(splitBlocks("x\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\ny")).toEqual([
      "x",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "y",
    ]);
    expect(splitBlocks("open\n\n```\nnot closed\n\nstill code")).toEqual([
      "open",
      "```\nnot closed\n\nstill code",
    ]);
    expect(splitBlocks("")).toEqual([]);
  });

  it("keeps a ~~~ fence whole, and a ``` line inside it does not close it", () => {
    expect(splitBlocks("~~~\na\n\n```\nb\n\n~~~\n\nz")).toEqual(["~~~\na\n\n```\nb\n\n~~~", "z"]);
  });

  it("closes a fence only with a marker at least as long, with no text after it", () => {
    expect(splitBlocks("````\na\n\n```\nb\n\n````\n\nz")).toEqual(["````\na\n\n```\nb\n\n````", "z"]);
    expect(splitBlocks("```\na\n\n``` not a closer\nb\n\n```\n\nz")).toEqual([
      "```\na\n\n``` not a closer\nb\n\n```",
      "z",
    ]);
  });

  it("keeps a fence inside a list item whole", () => {
    expect(splitBlocks("- item\n\n  ```\n  code\n\n  more\n  ```\n\n- next")).toEqual([
      "- item",
      "  ```\n  code\n\n  more\n  ```",
      "- next",
    ]);
  });

  it("treats whitespace-only lines as blank and drops leading and trailing blanks", () => {
    expect(splitBlocks("\n\n a\n \t \nb\n\n")).toEqual([" a", "b"]);
    expect(splitBlocks("\n \n")).toEqual([]);
  });

  it("is a prefix-stable split: growing the text only changes the last block", () => {
    const text = "p1\n\np2\n\n```\ncode\n\nmore";
    const whole = splitBlocks(text);
    for (let end = 1; end <= text.length; end += 1) {
      const part = splitBlocks(text.slice(0, end));
      expect(part.slice(0, -1)).toEqual(whole.slice(0, part.length - 1));
    }
  });

  it("is linear on hostile input", () => {
    const shapes = [
      "```\n".repeat(50_000),
      "~~~\n".repeat(50_000),
      "\n".repeat(200_000),
      "a\n\n".repeat(60_000),
      `\`\`\`${"`".repeat(100_000)}`,
      "- x\n\n  ```\n".repeat(30_000),
      " ".repeat(200_000),
    ];
    for (const shape of shapes) {
      const small = shape.slice(0, shape.length / 2);
      const t0 = performance.now();
      splitBlocks(small);
      const half = performance.now() - t0;
      const t1 = performance.now();
      splitBlocks(shape);
      const full = performance.now() - t1;
      // Doubling the input must not square the time: generous bound, still catches quadratic work at this size.
      expect(full).toBeLessThan(Math.max(half * 8, 50));
    }
  });
});
