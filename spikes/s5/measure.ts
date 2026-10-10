import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;
const gzipOf = (file: string) => gzipSync(readFileSync(file)).length;

const jsFiles = (dir: string) => readdirSync(join(dir, "assets")).filter((file) => file.endsWith(".js"));
const totalGzipKb = (dir: string) => kb(jsFiles(dir).reduce((sum, file) => sum + gzipOf(join(dir, "assets", file)), 0));

/** JS the browser fetches before first paint: the entry script and its modulepreload links; the rest is lazy (dynamic import). */
const initialGzipKb = (dir: string) => {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const hrefs = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1] as string);
  return kb(hrefs.reduce((sum, href) => sum + gzipOf(join(dir, href)), 0));
};

const licence = (pkg: string) => (JSON.parse(readFileSync(join("node_modules", pkg, "package.json"), "utf8")) as { license?: string }).license ?? "missing";
const version = (pkg: string) => (JSON.parse(readFileSync(join("node_modules", pkg, "package.json"), "utf8")) as { version: string }).version;

const modes = ["baseline", "codemirror", "codemirror-syntax", "pierre", "pierre-worker"] as const;
for (const mode of modes) execFileSync("corepack", ["pnpm", "exec", "vite", "build", "--mode", mode], { stdio: ["ignore", 2, 2] });

const gzip = Object.fromEntries(
  modes.map((mode) => [mode, { total: totalGzipKb(`dist-${mode}`), initial: initialGzipKb(`dist-${mode}`), jsFiles: jsFiles(`dist-${mode}`).length }]),
);
const baselineInitial = gzip["baseline"]?.initial ?? 0;

console.log(
  JSON.stringify(
    {
      note: "gzip KB of the Vite build (target safari16.4). baseline = React 19 + react-dom + page glue, no diff library. initial = entry chunk + modulepreload; total = every JS file (lazy chunks included).",
      gzipKb: gzip,
      libraryInitialKbOverBaseline: Object.fromEntries(modes.filter((mode) => mode !== "baseline").map((mode) => [mode, Math.round(((gzip[mode]?.initial ?? 0) - baselineInitial) * 10) / 10])),
      versions: { "@codemirror/merge": version("@codemirror/merge"), "@pierre/diffs": version("@pierre/diffs") },
      licences: { "@codemirror/merge": licence("@codemirror/merge"), "@pierre/diffs": licence("@pierre/diffs") },
    },
    null,
    2,
  ),
);
