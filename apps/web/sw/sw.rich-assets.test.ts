import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { richLazyAssets, type BundleLike } from "../vite/rich-assets.ts";
import { serviceWorker } from "../vite/service-worker.ts";

const chunk = (
  fileName: string,
  moduleIds: string[],
  imports: string[] = [],
  dynamicImports: string[] = [],
  css: string[] = [],
  isEntry = false,
) => ({
  isEntry,
  type: "chunk" as const,
  fileName,
  moduleIds,
  imports,
  dynamicImports,
  viteMetadata: { importedCss: new Set(css) },
});
const asset = (fileName: string) => ({ type: "asset" as const, fileName });

const MATH = "/r/packages/ui/src/ai/markdown/math.ts";
const MERMAID = "/r/packages/ui/src/ai/markdown/mermaid.ts";

const bundle = (): BundleLike => {
  const items = [
    chunk(
      "assets/index-1.js",
      ["/r/apps/web/src/main.tsx"],
      ["assets/shared-1.js"],
      ["assets/render-1.js"],
      [],
      true,
    ),
    chunk("assets/shared-1.js", ["/r/node_modules/react/index.js"], [], ["assets/tooltip-1.js"]),
    chunk("assets/tooltip-1.js", ["/r/apps/web/src/tooltip.tsx"], ["assets/shared-1.js"]),
    chunk(
      "assets/render-1.js",
      ["/r/packages/ui/src/ai/markdown/render.tsx"],
      ["assets/shared-1.js"],
      ["assets/math-1.js", "assets/mermaid-1.js", "assets/other-lazy-1.js"],
    ),
    chunk("assets/math-1.js", [MATH], ["assets/katex-core-1.js"], [], ["assets/math-1.css"]),
    chunk("assets/katex-core-1.js", ["/r/node_modules/katex/dist/katex.mjs"]),
    chunk(
      "assets/mermaid-1.js",
      [MERMAID],
      ["assets/mermaid-core-1.js", "assets/shared-1.js"],
      ["assets/flowDiagram-1.js"],
    ),
    chunk(
      "assets/mermaid-core-1.js",
      ["/r/node_modules/mermaid/dist/mermaid.core.mjs"],
      [],
      ["assets/ganttDiagram-1.js"],
    ),
    chunk(
      "assets/flowDiagram-1.js",
      ["/r/node_modules/mermaid/dist/flowDiagram.mjs"],
      ["assets/mermaid-core-1.js"],
    ),
    chunk(
      "assets/ganttDiagram-1.js",
      ["/r/node_modules/mermaid/dist/ganttDiagram.mjs"],
      ["assets/mermaid-core-1.js"],
    ),
    chunk("assets/other-lazy-1.js", ["/r/apps/web/src/other.tsx"], ["assets/shared-1.js"]),
    asset("assets/index-1.css"),
    asset("assets/math-1.css"),
    asset("assets/KaTeX_Main-Regular-abc.woff2"),
    asset("assets/KaTeX_Math-Italic-abc.woff2"),
    asset("assets/manrope-latin-wght-normal-abc.woff2"),
  ];
  return Object.fromEntries(items.map((item) => [item.fileName, item]));
};

describe("richLazyAssets", () => {
  it("names the math and Mermaid chunks, what only they use, their stylesheet and the KaTeX fonts", () => {
    expect([...richLazyAssets(bundle())].sort()).toEqual([
      "assets/KaTeX_Main-Regular-abc.woff2",
      "assets/KaTeX_Math-Italic-abc.woff2",
      "assets/flowDiagram-1.js",
      "assets/ganttDiagram-1.js",
      "assets/katex-core-1.js",
      "assets/math-1.css",
      "assets/math-1.js",
      "assets/mermaid-1.js",
      "assets/mermaid-core-1.js",
    ]);
  });

  it("keeps a chunk that anything else also loads, and every other asset", () => {
    const all = richLazyAssets(bundle());
    for (const kept of [
      "assets/index-1.js",
      "assets/shared-1.js",
      "assets/render-1.js",
      "assets/other-lazy-1.js",
      "assets/index-1.css",
      "assets/manrope-latin-wght-normal-abc.woff2",
    ])
      expect(all.has(kept), kept).toBe(false);
  });

  it("an app chunk that only a shared chunk imports dynamically stays precached (the rich side reaches that shared chunk too)", () => {
    const all = richLazyAssets(bundle());
    expect(all.has("assets/tooltip-1.js")).toBe(false);
    expect(all.has("assets/shared-1.js")).toBe(false);
  });

  it("a chunk the app imports dynamically stays precached, though the rich modules reach it too", () => {
    const items = bundle();
    const other = items["assets/other-lazy-1.js"];
    if (other?.type !== "chunk") throw new Error("fixture");
    items["assets/other-lazy-1.js"] = { ...other, dynamicImports: ["assets/katex-core-1.js"] };
    expect(richLazyAssets(items).has("assets/katex-core-1.js")).toBe(false);
  });

  it("a chunk that the shell also imports stays precached", () => {
    const items = bundle();
    const other = items["assets/other-lazy-1.js"];
    if (other?.type !== "chunk") throw new Error("fixture");
    items["assets/other-lazy-1.js"] = { ...other, imports: [...other.imports, "assets/katex-core-1.js"] };
    expect(richLazyAssets(items).has("assets/katex-core-1.js")).toBe(false);
  });
});

describe("the service worker's precache list", () => {
  it("leaves the rich-reply lazy assets out and keeps the rest of the build", async () => {
    const plugin = serviceWorker();
    (plugin.configResolved as unknown as (config: object) => void)({
      publicDir: fileURLToPath(new URL("../public", import.meta.url)),
      build: { lib: false },
    });
    const generate = plugin.generateBundle as unknown as {
      handler(
        this: { emitFile(file: { source: string }): void },
        options: object,
        bundle: object,
      ): Promise<void>;
    };
    const emitted: Array<{ source: string }> = [];
    const items: Record<string, unknown> = {
      ...bundle(),
      "index.html": { type: "asset", source: "<html></html>" },
    };
    for (const item of Object.values(bundle()))
      if (item.type === "chunk") Object.assign(items[item.fileName] as object, { code: item.fileName });
      else Object.assign(items[item.fileName] as object, { source: item.fileName });
    await generate.handler.call({ emitFile: (file) => void emitted.push(file) }, {}, items);
    const text = emitted[0]?.source ?? "";
    for (const kept of [
      "assets/index-1.js",
      "assets/shared-1.js",
      "assets/render-1.js",
      "assets/index-1.css",
    ])
      expect(text, kept).toContain(kept);
    for (const left of [
      "math-1",
      "mermaid-1",
      "mermaid-core-1",
      "flowDiagram-1",
      "katex-core-1",
      "KaTeX_Main",
    ])
      expect(text, left).not.toContain(left);
  });
});
