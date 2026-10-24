import { describe, expect, it } from "vitest";
import { readProjectConfig } from "./project-config.ts";

const read = (text: string) => readProjectConfig(new TextEncoder().encode(text));

describe("readProjectConfig packages", () => {
  it("packages: at most 64 SystemPackage names", () => {
    const names = Array.from({ length: 64 }, (_, index) => `pkg${index}`);
    expect(read(`packages: [${names.join(", ")}]\n`)).toMatchObject({ ok: true, packages: names });
    expect(read(`packages: [${[...names, "one-more"].join(", ")}]\n`)).toMatchObject({
      ok: true,
      badPackages: true,
    });
    for (const bad of [
      "[Upper]",
      "[-lead]",
      "[a b]",
      "[a, a]",
      "ripgrep",
      "[1]",
      `[${"x".repeat(64)}]`,
      "{a: b}",
    ])
      expect(read(`packages: ${bad}\n`), bad).toMatchObject({ ok: true, badPackages: true });
  });

  it("is absent when the file does not name the field, and never changes the lanes' fields", () => {
    expect(read("setup: make\n")).toEqual({ ok: true, config: { setup: "make" }, warnings: [] });
    expect(read("packages: [ripgrep]\nsetup: make\n")).toEqual({
      ok: true,
      config: { setup: "make" },
      warnings: [],
      packages: ["ripgrep"],
    });
    expect(read("packages: []\n")).toMatchObject({ ok: true, packages: [] });
  });

  it("refuses what the lanes refuse", () => {
    expect(read("- a\n")).toEqual({ ok: false, error: "not_a_map" });
    expect(read("a: &x 1\nb: *x\n")).toEqual({ ok: false, error: "invalid_yaml" });
    expect(readProjectConfig(new Uint8Array(70 * 1024))).toEqual({ ok: false, error: "too_large" });
  });
});
