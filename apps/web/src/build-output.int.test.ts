import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";
import { LAZY_MARKERS } from "./build-output.markers.ts";

const run = promisify(execFile);

// Loads one built chunk with string evaluation refused, as the daemon's CSP does, and prints the attempt count.
const EVAL_PROBE = `
const refused = [];
const Real = globalThis.Function;
globalThis.Function = new Proxy(Real, {
  apply(target, self, args) { if (args.length) { refused.push(args); throw new EvalError("refused"); } return Reflect.apply(target, self, args); },
  construct(target, args, newTarget) { if (args.length) { refused.push(args); throw new EvalError("refused"); } return Reflect.construct(target, args, newTarget); },
});
await import(process.argv[1]);
console.log(refused.length);
`;

// Mermaid reads `document` while it loads: the same refusal, run over every chunk of its closure in one process, with a
// happy-dom window in place. Prints one JSON line: the chunks that asked for eval (or failed to load) and how often.
const MERMAID_PROBE = `
const { Window } = await import(process.argv[1]);
const win = new Window({ url: "https://pap.test/" });
for (const key of ["document", "navigator", "location", "Element", "HTMLElement", "SVGElement", "Node", "DOMParser", "XMLSerializer", "getComputedStyle", "MutationObserver"]) { try { globalThis[key] = win[key]; } catch { /* a getter-only global of Node */ } }
globalThis.window = win;
let refused = 0;
const Real = globalThis.Function;
globalThis.Function = new Proxy(Real, {
  apply(target, self, args) { if (args.length) { refused += 1; throw new EvalError("refused"); } return Reflect.apply(target, self, args); },
  construct(target, args, newTarget) { if (args.length) { refused += 1; throw new EvalError("refused"); } return Reflect.construct(target, args, newTarget); },
});
const bad = {};
for (const file of JSON.parse(process.argv[2])) {
  refused = 0;
  try { await import(file); } catch (failure) { bad[file] = String(failure).slice(0, 120); continue; }
  if (refused > 0) bad[file] = refused;
}
console.log(JSON.stringify(bad));
`;

const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");

let out = "";
let html = "";
let css = "";
let assets: string[] = [];

// The daemon sends `script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'`
// (R74). What it cannot allow is checked on the files the build really writes.
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "pap-web-build-"));
  vi.stubEnv("NODE_ENV", "production");
  await build({
    root: webRoot,
    logLevel: "silent",
    // The production bundle reads @pap/contracts from its dist, which `pnpm build` makes first: read the source here.
    resolve: { alias: { "@pap/contracts": join(repoRoot, "packages/contracts/src/index.ts") } },
    build: { outDir: out, emptyOutDir: true },
  });
  html = await readFile(join(out, "index.html"), "utf8");
  assets = await readdir(join(out, "assets"));
  // Every stylesheet the build writes, so a second CSS chunk is checked as well.
  const cssFiles = assets.filter((name) => name.endsWith(".css"));
  css = (await Promise.all(cssFiles.map((name) => readFile(join(out, "assets", name), "utf8")))).join("\n");
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(out, { recursive: true, force: true });
});

describe("the built web app under the daemon's CSP", () => {
  it("has no inline script and no inline event handler", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc="\/assets\/[^"]+\.js"/);
      expect(body?.trim()).toBe("");
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("runs the appearance boot script before anything else, as a blocking external file (R74)", async () => {
    const head = html.slice(0, html.indexOf("</head>"));
    const first = /<script\b([^>]*)>/.exec(head);
    expect(first?.[1]).toMatch(/src="\/assets\/appearance-boot-[0-9a-f]{10}\.js"/);
    expect(first?.[1]).not.toMatch(/type="module"|defer|async/);
    const file = /src="\/assets\/(appearance-boot-[0-9a-f]{10}\.js)"/.exec(head)?.[1] ?? "";
    expect(await readFile(join(out, "assets", file), "utf8")).toContain('"pap.appearance.boot"');
  });

  it("loads only from its own origin", () => {
    const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references)
      expect(reference, String(reference)).toMatch(
        /^\/(?:assets\/|favicon\.svg$|manifest\.webmanifest$|icons\/apple-touch-icon\.png$)/,
      );
    expect(css).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
  });

  it("names the tab pap and serves the favicon from the build", async () => {
    expect(html).toContain("<title>pap</title>");
    expect(html).toContain('href="/favicon.svg"');
    expect((await readFile(join(out, "favicon.svg"), "utf8")).startsWith("<svg")).toBe(true);
  });

  it("serves Manrope and JetBrains Mono as woff2 files, never inlined as data: URIs", async () => {
    const fonts = assets.filter((name) => name.endsWith(".woff2") && !name.startsWith("KaTeX_"));
    expect(fonts.map((name) => name.replace(/-[\w-]{8}\.woff2$/, "")).sort()).toEqual([
      "jetbrains-mono-latin-ext-wght-normal",
      "jetbrains-mono-latin-wght-normal",
      "manrope-latin-ext-wght-normal",
      "manrope-latin-wght-normal",
    ]);
    for (const name of fonts) {
      const bytes = await readFile(join(out, "assets", name));
      expect(bytes.subarray(0, 4).toString("latin1"), name).toBe("wOF2");
      expect(css, name).toContain(`url(/assets/${name})`);
    }
    expect(css).not.toContain("data:");
    expect(css).toMatch(/font-family:\s*"?Manrope"?/);
    expect(css).toMatch(/font-family:\s*"?JetBrains Mono"?/);
  });

  // KaTeX's fonts ship as woff2 files only (katexFonts), never inlined (UX2-R47), reached only from the lazy math chunk's CSS.
  it("serves KaTeX's fonts as files from a lazy stylesheet, never inlined and never initial (UX2-R47)", async () => {
    const initial = new Set([...html.matchAll(/href="\/assets\/([^"]+\.css)"/g)].map((m) => m[1] ?? ""));
    const sheets = new Map<string, string>();
    for (const name of assets.filter((asset) => asset.endsWith(".css")))
      sheets.set(name, await readFile(join(out, "assets", name), "utf8"));
    const katexSheets = [...sheets].filter(([, text]) => /@font-face\{[^}]*KaTeX_Main/u.test(text));
    expect(katexSheets.length).toBe(1);
    for (const [name, text] of katexSheets) {
      expect(initial.has(name), name).toBe(false);
      expect(text).not.toContain("data:");
      const urls = [...text.matchAll(/url\(\/assets\/(KaTeX_[^)]+\.woff2)\)/gu)].map((m) => m[1] ?? "");
      expect(urls.length).toBeGreaterThan(0);
      for (const file of urls) expect(assets, file).toContain(file);
      expect(assets.filter((name) => name.startsWith("KaTeX_") && !name.endsWith(".woff2"))).toEqual([]);
    }
    for (const name of initial) expect(sheets.get(name) ?? "", name).not.toMatch(/KaTeX_|\.katex\b/u);
    expect(css).toMatch(/\.contain-rich\s*\{[^}]*contain:\s*paint/u);
    expect(css).toMatch(/\.contain-rich-inline\s*\{[^}]*contain:\s*paint/u);
  });

  it("ships CSS without native nesting, which Safari 16.4 cannot read", () => {
    expect(css).not.toMatch(/(^|[{;\s])&[:.[\s>+~]/);
  });

  it("ships no WebAssembly: the CSP has no 'wasm-unsafe-eval' (R74)", () => {
    expect(assets.filter((name) => name.endsWith(".wasm"))).toEqual([]);
  });

  // zod probes for eval with `Function("")` when it builds its first object schema (the `Cloudflare` marker is that
  // probe). The chunk that holds zod must switch it off before any schema it contains is built (I1 of the final review).
  it("never asks for eval while the chunk that holds zod loads (R74)", async () => {
    const holders: string[] = [];
    for (const name of assets.filter((asset) => asset.endsWith(".js")))
      if (/Cloudflare/.test(await readFile(join(out, "assets", name), "utf8"))) holders.push(name);
    expect(holders.length).toBeGreaterThan(0);
    for (const name of holders) {
      // The probe only sees what the chunk builds when it loads. If zod sat in a chunk without schemas it would
      // report 0 while the schema chunk still violated the CSP, so the switch must be in the chunk that holds zod.
      expect(await readFile(join(out, "assets", name), "utf8"), name).toMatch(/jitless:\s*(?:!0|true)/);
      const { stdout } = await run(
        process.execPath,
        ["--input-type=module", "-e", EVAL_PROBE, pathToFileURL(join(out, "assets", name)).href],
        { cwd: out },
      );
      expect(stdout.trim(), name).toBe("0");
    }
  });

  // UX2-R49, R84: Mermaid's core and its diagram types are lazy chunks, none in an initial file, and none asks for string
  // evaluation while it loads (a core that did would stop the task: the app CSP has no 'unsafe-eval'). Drawing is checked
  // in a browser by J18. The closure stops at the renderer's chunk and the shared one: it is the lazy side only.
  it("loads every Mermaid chunk with string evaluation refused, and keeps Mermaid out of the initial assets (UX2-R49)", async () => {
    const initial = new Set(
      [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((match) => match[1] ?? ""),
    );
    const text = new Map<string, string>();
    for (const name of assets.filter((asset) => asset.endsWith(".js")))
      text.set(name, await readFile(join(out, "assets", name), "utf8"));
    const roots = [...text].filter(
      ([, code]) => /securityLevel/.test(code) && code.includes("ui-sans-serif, system-ui, sans-serif"),
    );
    expect(roots.length).toBeGreaterThan(0);
    const closure = new Set<string>();
    const queue = roots.map(([name]) => name);
    for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
      const code = text.get(name);
      if (code === undefined || closure.has(name) || initial.has(name) || code.includes("data-markdown-body"))
        continue;
      closure.add(name);
      for (const match of code.matchAll(/["'`]\.\/([^"'`]+\.js)["'`]/g)) queue.push(match[1] ?? "");
    }
    // The core and the diagram types (flowchart, sequence, class, state, gantt among them).
    expect(closure.size).toBeGreaterThan(20);
    for (const name of closure) expect(initial.has(name), name).toBe(false);
    for (const type of ["flowDiagram", "sequenceDiagram", "classDiagram", "stateDiagram", "ganttDiagram"])
      expect(
        [...closure].some((name) => name.startsWith(type)),
        type,
      ).toBe(true);
    const happyDom = pathToFileURL(createRequire(join(repoRoot, "package.json")).resolve("happy-dom")).href;
    const files = JSON.stringify(
      [...closure].sort().map((name) => pathToFileURL(join(out, "assets", name)).href),
    );
    const { stdout } = await run(
      process.execPath,
      ["--input-type=module", "-e", MERMAID_PROBE, happyDom, files],
      { cwd: out, maxBuffer: 1 << 20 },
    );
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({});
  }, 120_000);

  it("keeps the initial JavaScript and CSS within the declared gzip budget", async () => {
    const budget = (
      JSON.parse(await readFile(join(repoRoot, "budgets.json"), "utf8")) as { initialBundleGzipKb: number }
    ).initialBundleGzipKb;
    const initial = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.(?:js|css))"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(initial.length).toBeGreaterThanOrEqual(2);
    let bytes = 0;
    for (const name of initial) bytes += gzipSync(await readFile(join(out, "assets", name))).length;
    expect(bytes / 1024).toBeLessThanOrEqual(budget);
  });

  // A lazy chunk holds the marker and no initial file does (the initial files are the ones index.html names).
  const keepsLazyOnly = async (markers: readonly RegExp[]) => {
    const initial = new Set(
      [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((match) => match[1] ?? ""),
    );
    const scripts = assets.filter((asset) => asset.endsWith(".js"));
    for (const marker of markers) {
      const holders: string[] = [];
      for (const name of scripts) {
        if (marker.test(await readFile(join(out, "assets", name), "utf8"))) holders.push(name);
      }
      expect(holders.length, String(marker)).toBeGreaterThan(0);
      expect(
        holders.filter((name) => initial.has(name)),
        String(marker),
      ).toEqual([]);
    }
  };

  for (const { title, markers } of LAZY_MARKERS) it(title, () => keepsLazyOnly(markers));

  it("keeps Settings › Models and its strings out of the initial assets, in a chunk of its own (M7R71)", async () => {
    await keepsLazyOnly([/data-models-section/, /Refresh catalog/, /Actualiser le catalogue/]);
    // Its own chunk: the file that holds the section is not the one that holds the Settings screen.
    const holders: string[] = [];
    for (const name of assets.filter((asset) => asset.endsWith(".js"))) {
      const code = await readFile(join(out, "assets", name), "utf8");
      if (/data-models-section/.test(code)) holders.push(code);
    }
    expect(holders.length).toBeGreaterThan(0);
    for (const code of holders) expect(code).not.toMatch(/data-settings-screen/);
  });

  it("keeps the home's composer in the initial assets: the first paint at / waits for no chunk (§8)", async () => {
    const initial = [...html.matchAll(/src="\/assets\/([^"]+\.js)"/g)].map((match) => match[1] ?? "");
    const texts = await Promise.all(initial.map((name) => readFile(join(out, "assets", name), "utf8")));
    expect(texts.some((code) => /"data-home":/.test(code) && code.includes("data-home-body") === false)).toBe(
      true,
    );
  });

  it("keeps the files, changes and terminal panes out of the initial assets, each in a chunk of its own (M8R71)", async () => {
    await keepsLazyOnly([/data-files-pane/, /data-changes-pane/, /data-terminal-pane/]);
    const holders = new Map<string, string[]>();
    for (const marker of ["data-files-pane", "data-changes-pane", "data-terminal-pane"])
      for (const name of assets.filter((asset) => asset.endsWith(".js")))
        if ((await readFile(join(out, "assets", name), "utf8")).includes(marker))
          holders.set(marker, [...(holders.get(marker) ?? []), name]);
    const chunks = [...holders.values()].flat();
    expect(chunks).toHaveLength(3);
    expect(new Set(chunks).size).toBe(3);
  });

  // The entry is built on its own to see both CodeMirror and the merge view (the app build holds the editor only, above).
  // What a consumer imports statically is that entry file (M8R74).
  it("keeps CodeMirror and the merge view out of the @pap/ui/code entry, in chunks of their own (M8R74)", async () => {
    const codeOut = await mkdtemp(join(tmpdir(), "pap-ui-code-"));
    try {
      await build({
        configFile: false,
        root: repoRoot,
        logLevel: "silent",
        oxc: { jsx: { runtime: "automatic" } },
        build: {
          outDir: codeOut,
          emptyOutDir: true,
          minify: true,
          lib: { entry: join(repoRoot, "packages/ui/src/code.ts"), formats: ["es"], fileName: "code" },
          rolldownOptions: { external: ["react", "react/jsx-runtime"] },
        },
      });
      const files = (await readdir(codeOut)).filter((name) => name.endsWith(".js"));
      // What loading the entry pulls in at once: the entry and the chunks it imports statically (a dynamic import is lazy).
      const text = new Map<string, string>();
      for (const name of files) text.set(name, await readFile(join(codeOut, name), "utf8"));
      const eager = new Set<string>();
      const visit = (name: string) => {
        if (eager.has(name) || !text.has(name)) return;
        eager.add(name);
        for (const match of text.get(name)?.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g) ?? [])
          visit(match[1] ?? "");
      };
      visit("code.js");
      expect(
        [...eager].filter((name) => /cm-editor|cm-mergeView|cm-content/.test(text.get(name) ?? "")),
      ).toEqual([]);
      const lazy = files.filter((name) => !eager.has(name));
      expect(lazy.length).toBeGreaterThan(8);
      for (const marker of [/cm-editor/, /cm-mergeView/]) {
        const holders: string[] = [];
        for (const name of lazy) if (marker.test(text.get(name) ?? "")) holders.push(name);
        expect(holders.length, String(marker)).toBeGreaterThan(0);
      }
    } finally {
      await rm(codeOut, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps the markdown renderer and the highlighter out of the initial assets (owner R3-1, R3-5)", async () => {
    const initial = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1] ?? "");
    for (const name of initial)
      expect(await readFile(join(out, "assets", name), "utf8"), name).not.toMatch(
        /data-markdown-body|pap-code/,
      );
    await keepsLazyOnly([/data-markdown-body/]);
  });

  it("ships nothing of the /dev/ui gallery in any production asset, initial or lazy (ADR 0011, M3R122)", async () => {
    const markers = [
      /data-gallery-section/,
      /data-gallery-item/,
      /data-slot":\W*gallery-frame/,
      /Every component of @pap\/ui/,
      /Chaque composant de @pap\/ui/,
      // The pane title of the dev-ui item: dev builds only, so a production page never names the gallery.
      /UI gallery/,
      /Galerie de l'interface/,
    ];
    const everything = [
      html,
      ...(await Promise.all(assets.map((name) => readFile(join(out, "assets", name))))).map((bytes) =>
        bytes.toString("latin1"),
      ),
    ];
    expect(everything.length).toBeGreaterThan(10);
    for (const marker of markers)
      expect(everything.filter((content) => marker.test(content)).length, String(marker)).toBe(0);
  });
});
