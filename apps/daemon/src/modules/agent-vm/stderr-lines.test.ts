import { describe, expect, it } from "vitest";
import { createLineSplitter, PARTIAL_MAX_CHARS } from "./stderr-lines.ts";

/*
 * Mutants (RT-43), each run for real in the T15b fix report:
 *  - M-partial-max: PARTIAL_MAX_CHARS is made huge -> "cuts a line at the cap" fails.
 *  - M-no-discard: the rest of a cut line is kept and logged as a line -> "drops the rest of a cut line" fails.
 *  - M-discard-forever: the discard never ends at the newline -> "resumes at the next newline" fails.
 */
function splitter() {
  const lines: string[] = [];
  const feed = createLineSplitter((line) => lines.push(line));
  return { lines, feed };
}

describe("the relay's stderr lines", () => {
  it("splits on newlines across chunks and skips empty lines", () => {
    const { lines, feed } = splitter();
    feed("one\ntw");
    feed("o\n\nthree");
    feed("\n");
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("cuts a line at the cap (M-partial-max): the cap is a few KiB, not unbounded", () => {
    const { lines, feed } = splitter();
    feed("a".repeat(PARTIAL_MAX_CHARS + 5));
    expect(lines).toEqual(["a".repeat(PARTIAL_MAX_CHARS)]);
    expect(PARTIAL_MAX_CHARS).toBe(16_384);
  });

  it("does not cut a line one short of the cap", () => {
    const { lines, feed } = splitter();
    feed("a".repeat(PARTIAL_MAX_CHARS));
    expect(lines).toEqual([]);
    feed("\n");
    expect(lines).toEqual(["a".repeat(PARTIAL_MAX_CHARS)]);
  });

  it("drops the rest of a cut line, whatever the chunks (M-no-discard), and resumes at the next newline (M-discard-forever)", () => {
    const { lines, feed } = splitter();
    feed("x".repeat(PARTIAL_MAX_CHARS + 1));
    feed("more of the same line");
    feed(" and more\nnext");
    feed(" line\n");
    expect(lines).toEqual(["x".repeat(PARTIAL_MAX_CHARS), "next line"]);
  });

  it("a value cut across the cap leaves no suffix in the log", () => {
    const { lines, feed } = splitter();
    const value = "vault-value-EEEEEEEEEE";
    feed(`${"a".repeat(PARTIAL_MAX_CHARS - 5)}${value}`);
    feed("\n");
    expect(lines.join("\n")).not.toContain("EEEEEEEEE");
  });
});
