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

describe("readProjectConfig preview", () => {
  it("reads a valid preview and leaves the other fields alone", () => {
    expect(read("preview:\n  command: npm run dev\n  port: 5173\nsetup: make\n")).toEqual({
      ok: true,
      config: { setup: "make" },
      warnings: [],
      preview: { command: "npm run dev", port: 5173 },
    });
  });

  it("names a bad preview and keeps the packages", () => {
    for (const bad of [
      "preview: 5\n",
      "preview:\n  command: x\n  port: 80\n",
      "preview:\n  command: x\n  port: 7842\n",
      "preview:\n  command: x\n",
      "preview:\n  command: x\n  port: 8000\n  extra: 1\n",
    ]) {
      const result = read(`${bad}packages: [jq]\n`);
      expect(result, bad).toMatchObject({ ok: true, badPreview: true, packages: ["jq"] });
      expect(result, bad).not.toHaveProperty("preview");
    }
  });

  it("is absent when the file does not name the field", () => {
    const result = read("setup: make\n");
    expect(result).not.toHaveProperty("preview");
    expect(result).not.toHaveProperty("badPreview");
  });
});
