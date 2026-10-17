import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightCode, MAX_HIGHLIGHT_CHARS } from "./highlight.ts";

describe("code highlighting with shiki's JavaScript regex engine (R74: no WebAssembly)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("highlights TypeScript without ever compiling WebAssembly", async () => {
    const refuse = () => {
      throw new Error("WebAssembly is not allowed by the CSP (R74)");
    };
    vi.stubGlobal("WebAssembly", {
      compile: refuse,
      instantiate: refuse,
      compileStreaming: refuse,
      instantiateStreaming: refuse,
      validate: refuse,
    });
    const lines = await highlightCode("const x = 1; // one", "ts");
    const tokens = (lines ?? []).flat();
    expect(tokens.map((token) => token.content).join("")).toBe("const x = 1; // one");
    expect(tokens.find((token) => token.content.includes("one"))?.color).toBe("var(--shiki-token-comment)");
    // This is the cold load of shiki's engine and grammars: under a full gate it can pass the default 5 s (flaked once
    // in task 7), so it gets room instead of a warm-up that would hide the load from the WebAssembly guard above.
  }, 30_000);

  it("lets only css-variable colours through", async () => {
    const tokens = (
      (await highlightCode('import { a } from "b";\nfunction f() { return 1; }', "typescript")) ?? []
    ).flat();
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token.color === null || /^var\(--shiki-[a-z-]+\)$/.test(token.color), token.color ?? "").toBe(
        true,
      );
    }
  });

  it.each(["constructor", "__proto__", "toString"])(
    "treats the object-prototype name %j as an unknown language",
    async (lang) => {
      expect(await highlightCode("x", lang)).toBeNull();
    },
  );

  it("marks comments italic and keywords not", async () => {
    const tokens = ((await highlightCode("const x = 1; // one", "ts")) ?? []).flat();
    expect(tokens.find((token) => token.content.includes("one"))?.italic).toBe(true);
    expect(tokens.find((token) => token.content === "const")?.italic).toBe(false);
  });

  it("leaves unknown languages and oversized code plain", async () => {
    expect(await highlightCode("x", "brainfuck")).toBeNull();
    expect(await highlightCode("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "ts")).toBeNull();
  });
});
