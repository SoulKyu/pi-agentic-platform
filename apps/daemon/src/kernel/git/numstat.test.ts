import { describe, expect, it } from "vitest";
import { parseNumstat } from "./numstat.ts";

const buf = (text: string) => Buffer.from(text, "utf8");

describe("parseNumstat", () => {
  it("reads counts per path", () => {
    const rows = parseNumstat(buf("12\t3\tsrc/a.ts\0"));
    expect([...rows]).toEqual([["src/a.ts", { additions: 12, deletions: 3 }]]);
  });

  it("maps a binary row to nulls", () => {
    expect([...parseNumstat(buf("-\t-\timg.png\0"))]).toEqual([
      ["img.png", { additions: null, deletions: null }],
    ]);
  });

  it("keys a rename by its new path", () => {
    const rows = parseNumstat(buf("5\t1\t\0old.ts\0new.ts\0"));
    expect([...rows]).toEqual([["new.ts", { additions: 5, deletions: 1 }]]);
  });

  it("reads rows after a rename and paths with tabs and newlines exactly", () => {
    const rows = parseNumstat(buf("5\t1\t\0old\0new\0-\t-\ta\tb\nc\0"));
    expect([...rows]).toEqual([
      ["new", { additions: 5, deletions: 1 }],
      ["a\tb\nc", { additions: null, deletions: null }],
    ]);
  });

  it("skips a malformed row and keeps the rest", () => {
    const rows = parseNumstat(buf("garbage\0x\ty\tz\0 1\t2\tok\0"));
    expect([...rows]).toEqual([]);
    expect([...parseNumstat(buf("garbage\0" + "1\t2\tok\0"))]).toEqual([
      ["ok", { additions: 1, deletions: 2 }],
    ]);
  });

  it("returns an empty map for empty output", () => {
    expect(parseNumstat(buf("")).size).toBe(0);
  });
});
