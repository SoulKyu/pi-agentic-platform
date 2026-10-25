import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
/** The token plumbing: the tone is derived and booted here, never painted. */
const PLUMBING = new Set(["features/appearance/derive.ts", "features/appearance/boot-script.js"]);
const DIM =
  /\b(?:text|bg|border|fill|stroke|ring|divide|outline|decoration|placeholder|caret|accent)-dim\b|--text-dim|color-dim/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|js|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the dim tone", () => {
  it("colours only idle avatars and disabled controls (no screen of apps/web paints it)", () => {
    const found = sources(SRC)
      .filter((path) => !PLUMBING.has(relative(SRC, path)))
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .split("\n")
          .flatMap((line, index) => (DIM.test(line) ? [`${relative(SRC, path)}:${index + 1}`] : [])),
      );
    expect(found).toEqual([]);
  });
});
