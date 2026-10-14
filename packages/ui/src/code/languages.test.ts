import { StreamLanguage } from "@codemirror/language";
import { afterEach, describe, expect, it, vi } from "vitest";
import { languageFor, loadLanguage } from "./languages.ts";

const javascript = vi.hoisted(() => vi.fn((config?: unknown) => ({ extension: [], config })));
vi.mock("@codemirror/lang-javascript", () => ({ javascript }));

describe("languageFor", () => {
  afterEach(() => javascript.mockClear());

  it("loads the JavaScript support with the typescript and jsx flags for a .tsx file", async () => {
    const loader = languageFor("src/a.tsx");
    expect(loader).toBeTypeOf("function");
    await loader?.();
    expect(javascript).toHaveBeenCalledExactlyOnceWith({ typescript: true, jsx: true });
  });

  it.each([
    ["a.ts", { typescript: true, jsx: false }],
    ["a.jsx", { typescript: false, jsx: true }],
    ["a.mjs", { typescript: false, jsx: false }],
    ["a.CJS", { typescript: false, jsx: false }],
  ])("flags %s", async (path, flags) => {
    await languageFor(path)?.();
    expect(javascript).toHaveBeenCalledExactlyOnceWith(flags);
  });

  it("gives Dockerfile and Dockerfile.dev the Dockerfile stream mode, by name", async () => {
    const plain = languageFor("Dockerfile");
    const dotted = languageFor("x/Dockerfile.dev");
    expect(plain).toBe(dotted);
    const support = await plain?.();
    expect(support).toBeInstanceOf(StreamLanguage);
    expect((support as StreamLanguage<unknown>).parser.parse("FROM node\n").toString()).toContain("keyword");
  });

  it("covers every extension of the ruling with a loader", () => {
    const covered =
      "ts tsx js jsx mjs cjs json jsonc md mdx py css scss less html htm yaml yml sh bash zsh toml go rs"
        .split(" ")
        .filter((extension) => languageFor(`a.${extension}`) === null);
    expect(covered).toEqual([]);
  });

  it("returns the same loader for the same language, so a component can compare them", () => {
    expect(languageFor("a.sh")).toBe(languageFor("b.zsh"));
  });

  it("is null for an unknown extension, a dotfile without one and an empty name", () => {
    expect([
      languageFor("a.unknown"),
      languageFor(".gitignore"),
      languageFor("README"),
      languageFor(""),
    ]).toEqual([null, null, null, null]);
  });
});

describe("loadLanguage", () => {
  it("is plain text, without a report, when there is no loader", async () => {
    const report = vi.fn();
    expect(await loadLanguage(null, report)).toEqual([]);
    expect(report).not.toHaveBeenCalled();
  });

  it("falls back to plain text and reports once when the loader rejects", async () => {
    const report = vi.fn();
    const loader = vi.fn(() => Promise.reject(new Error("chunk gone")));
    expect(await loadLanguage(loader, report)).toEqual([]);
    expect(report).toHaveBeenCalledOnce();
  });

  it("falls back to plain text when the loader throws before returning a promise", async () => {
    const report = vi.fn();
    expect(
      await loadLanguage(() => {
        throw new Error("sync");
      }, report),
    ).toEqual([]);
    expect(report).toHaveBeenCalledOnce();
  });
});
