import { describe, expect, it } from "vitest";
import { cloneName } from "./forks.ts";

describe("cloneName", () => {
  it.each([
    [null, null],
    ["", null],
    ["Fix login", /^Fix login · [0-9a-f]{4}$/],
    ["Fix login · 3f9a", /^Fix login · [0-9a-f]{4}$/],
    ["line one\nline two", /^line one line two · [0-9a-f]{4}$/],
    ["😀".repeat(50), /^(😀){39}… · [0-9a-f]{4}$/u],
    ["x".repeat(40), /^x{40} · [0-9a-f]{4}$/],
    ["x".repeat(41), /^x{39}… · [0-9a-f]{4}$/],
  ])("names the clone of %j", (title, expected) => {
    const name = cloneName(title);
    if (expected === null) expect(name).toBeNull();
    else expect(name).toMatch(expected);
  });

  it("drops only the last suffix and keeps a title that merely contains one", () => {
    expect(cloneName("a · 1234 · 5678")).toMatch(/^a · 1234 · [0-9a-f]{4}$/);
    expect(cloneName("a · 12345")).toMatch(/^a · 12345 · [0-9a-f]{4}$/);
  });

  it("never splits a surrogate pair or a lone-surrogate title into invalid text", () => {
    const name = cloneName(`${"a".repeat(39)}😀tail`) ?? "";
    expect(name).toMatch(/^a{39}… · [0-9a-f]{4}$/);
    expect(() => encodeURIComponent(name)).not.toThrow();
    expect(() => encodeURIComponent(cloneName("\ud800 broken") ?? "")).not.toThrow();
  });
});
