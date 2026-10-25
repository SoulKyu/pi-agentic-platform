import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
// A multiplication sign stays only as a count (`×{n}`, `×${n}`, `×3`).
const GLYPHS = /[⏱⇢◉▸★☆✓✗⊘●]|×(?![{$\d])/u;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|js)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("glyphs are icons or words", () => {
  it("no source or catalog value in apps/web uses ⏱ ⇢ ◉ ▸ ★ ☆ ✓ ✗ ⊘ ● as an icon", () => {
    const found: string[] = [];
    for (const path of sources(SRC)) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/^\s*(\/\/|\/?\*)/.test(line)) return;
          if (GLYPHS.test(line)) found.push(`${relative(SRC, path)}:${index + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});
