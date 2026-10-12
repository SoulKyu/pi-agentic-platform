import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");

// Owner R3-1, R74: markdown and highlighting are lazy chunks, and nothing in them needs WebAssembly.
describe("markdown build", () => {
  it("keeps the renderer and the highlighter out of Markdown's own chunk and emits no .wasm", async () => {
    const output = (await build({
      root: webRoot,
      configFile: join(webRoot, "vite.config.ts"),
      logLevel: "silent",
      build: {
        write: false,
        lib: {
          entry: join(repoRoot, "packages/ui/src/ai/Markdown.tsx"),
          formats: ["es"],
          fileName: "markdown",
        },
        rollupOptions: { external: (id) => /^(react|react-dom)(\/|$)/.test(id) },
      },
    })) as Rollup.RollupOutput[];
    const files = output.flatMap((o) => o.output);
    const chunks = files.filter((file): file is Rollup.OutputChunk => file.type === "chunk");
    const entry = chunks.find((chunk) => chunk.isEntry);
    expect(files.some((file) => file.fileName.endsWith(".wasm"))).toBe(false);
    expect(entry?.code).not.toMatch(/data-markdown-body|pap-code/);
    const renderer = chunks.find((chunk) => chunk.code.includes("data-markdown-body"));
    expect(renderer).toBeDefined();
    expect(renderer?.code).not.toContain("pap-code"); // shiki waits for the first code block
    expect(chunks.some((chunk) => chunk.code.includes("pap-code"))).toBe(true);
    expect(gzipSync(entry?.code ?? "").length).toBeLessThan(3 * 1024);
    for (const chunk of chunks) {
      console.info(
        `markdown build ${chunk.fileName}: ${(gzipSync(chunk.code).length / 1024).toFixed(1)} KB gzip`,
      );
    }
  }, 120_000);
});
