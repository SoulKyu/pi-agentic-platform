import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { minifySync, transformWithOxc, type Plugin } from "vite";
import { BROWSER_TARGETS } from "../browser-targets.ts";

const SOURCE = new URL("../sw/sw.ts", import.meta.url);
const PUBLIC_FILES = ["/favicon.svg", "/manifest.webmanifest"];

type Content = string | Uint8Array;
const sha256 = (content: Content): string => createHash("sha256").update(content).digest("hex");

/** The first 16 hex of the sha-256 over the sorted `path:content-sha256` lines of every shell file. */
export function buildIdOf(files: ReadonlyMap<string, Content>): string {
  const lines = [...files].map(([path, content]) => `${path}:${sha256(content)}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/**
 * TypeScript source -> one classic script, the two build constants still in place: types stripped, no `export`, syntax
 * lowered to the app's browser targets, minified (the shell list is about half of the gzip budget). The constants are
 * free globals to the minifier, so they survive it.
 */
export async function compileServiceWorker(source: string): Promise<string> {
  const classic = stripTypeScriptTypes(source, { mode: "strip" }).replace(/^export /gm, "");
  const lowered = await transformWithOxc(classic, "sw.js", { target: BROWSER_TARGETS });
  const { code, errors } = minifySync("sw.js", lowered.code, { compress: true, mangle: true, module: false });
  if (errors.length > 0)
    throw new Error(`pap-service-worker: minify failed: ${errors.map((e) => e.message).join("; ")}`);
  return code;
}

/** Inlines the build constants as plain JSON (function replacers: no `$` pattern is ever interpreted). */
export function inlineConstants(code: string, shell: readonly string[], buildId: string): string {
  return code
    .replaceAll("__BUILD_ID__", () => JSON.stringify(buildId))
    .replaceAll("__SHELL__", () => JSON.stringify(shell));
}

export async function renderServiceWorker(
  source: string,
  shell: readonly string[],
  buildId: string,
): Promise<string> {
  return inlineConstants(await compileServiceWorker(source), shell, buildId);
}

function publicShellFiles(publicDir: string): Map<string, Content> {
  const files = new Map<string, Content>();
  for (const path of PUBLIC_FILES) files.set(path, readFileSync(join(publicDir, path)));
  for (const name of readdirSync(join(publicDir, "icons")).sort())
    files.set(`/icons/${name}`, readFileSync(join(publicDir, "icons", name)));
  return files;
}

/**
 * Emits `sw.js` (unhashed, at the dist root: the browser re-checks that exact URL) with the precache list of the build.
 * Vite copies the public dir after generateBundle, so the public files are read from the source folder.
 */
export function serviceWorker(): Plugin {
  const source = readFileSync(SOURCE, "utf8");
  let publicDir: string | false = false;
  // A library build (a test probe of one component) has no page and no shell: only the app's own build gets a worker.
  let isLibrary = false;
  return {
    name: "pap-service-worker",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
      isLibrary = config.build.lib !== false;
    },
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        if (isLibrary) return;
        if (!publicDir)
          throw new Error("pap-service-worker: the public folder is required (manifest and icons)");
        const files = new Map<string, Content>();
        for (const [name, output] of Object.entries(bundle)) {
          if (!name.startsWith("assets/") || name.endsWith(".map")) continue;
          files.set(`/${name}`, output.type === "chunk" ? output.code : output.source);
        }
        const index = bundle["index.html"];
        if (index?.type !== "asset")
          throw new Error("pap-service-worker: index.html is not in the bundle yet");
        files.set("/", index.source);
        files.set("/index.html", index.source);
        for (const [path, content] of publicShellFiles(publicDir)) files.set(path, content);
        const assets = [...files.keys()].filter((path) => path.startsWith("/assets/")).sort();
        const publics = [...files.keys()].filter(
          (path) => !path.startsWith("/assets/") && path !== "/" && path !== "/index.html",
        );
        const shell = ["/", "/index.html", ...assets, ...publics];
        // The worker's own code is hashed too: a change to sw.ts alone must get a new cache name.
        const template = await compileServiceWorker(source);
        const buildId = buildIdOf(new Map([...files, ["sw.js#code", template]]));
        this.emitFile({
          type: "asset",
          fileName: "sw.js",
          source: inlineConstants(template, shell, buildId),
        });
      },
    },
  };
}
