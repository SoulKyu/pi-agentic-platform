import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";

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
  const cssFile = assets.find((name) => name.endsWith(".css"));
  css = cssFile ? await readFile(join(out, "assets", cssFile), "utf8") : "";
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

  it("loads only from its own origin", () => {
    const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(reference, String(reference)).toMatch(/^\/assets\//);
    expect(css).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
  });

  it("serves Manrope and JetBrains Mono as woff2 files, never inlined as data: URIs", async () => {
    const fonts = assets.filter((name) => name.endsWith(".woff2"));
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
});
