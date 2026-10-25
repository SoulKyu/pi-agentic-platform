import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LOADING_LINE_ALLOWED } from "./loading-lines.allow.ts";

const ROOT = import.meta.dirname;
const LOADING_KEY = /["'`][\w.]*(?<!section)\.(?:loading|panelLoading|reading)["'`]/;
const LOADING_TAGS = /<(?:LoadingLine|WaitLine)\b/;
const LOOKBACK = 6;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "i18n" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Lines that name a loading or reading message outside a `LoadingLine` or `WaitLine` opening within a few lines above. */
function strayLines(text: string): number[] {
  const lines = text.split("\n");
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (!LOADING_KEY.test(line) || /^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
    const window = lines.slice(Math.max(0, index - LOOKBACK), index + 1);
    if (!window.some((candidate) => LOADING_TAGS.test(candidate))) found.push(index + 1);
  });
  return found;
}

describe("loading lines", () => {
  const allowed = new Set(LOADING_LINE_ALLOWED.map((entry) => entry.file));
  const files = sources(ROOT).map((path) => ({
    file: relative(ROOT, path),
    text: readFileSync(path, "utf8"),
  }));

  it("no loading or reading status line in apps/web outside LoadingLine", () => {
    const stray = files.flatMap(({ file, text }) =>
      allowed.has(file) ? [] : strayLines(text).map((line) => `${file}:${line}`),
    );
    expect(stray).toEqual([]);
  });

  it("every allowlist entry names a reason and a file that still has a stray line", () => {
    for (const entry of LOADING_LINE_ALLOWED) {
      expect(entry.reason.length).toBeGreaterThan(0);
      const source = files.find(({ file }) => file === entry.file);
      expect(source, entry.file).toBeDefined();
      expect(strayLines(source?.text ?? "").length, entry.file).toBeGreaterThan(0);
    }
  });
});
