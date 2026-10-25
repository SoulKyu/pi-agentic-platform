import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL(".", import.meta.url).pathname;
const DIM = /\b(?:disabled:)?(?:text|bg|border)-dim\b|--text-dim/g;
const TOKEN_FILES = new Set([
  "tokens.css",
  "presets.ts",
  "token-names.ts",
  "tokens.test.ts",
  "dim-tone.test.ts",
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

/** One use of the dim tone is allowed: a `disabled:` variant, or the idle presence dot of Avatar. */
function offences(file: string, text: string): string[] {
  const name = relative(ROOT, file);
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(DIM)) {
      const at = match.index ?? 0;
      const disabled = line.slice(Math.max(0, at - 9), at + match[0].length).includes("disabled:");
      const idleAvatar = name === "primitives/Avatar.tsx" && match[0] === "bg-dim";
      if (!disabled && !idleAvatar) found.push(`${name}:${index + 1} ${match[0]}`);
    }
  });
  return found;
}

describe("the dim tone", () => {
  it("the dim tone colours only idle avatars and disabled controls", () => {
    const found = sources(ROOT)
      .filter((file) => !TOKEN_FILES.has(relative(ROOT, file)))
      .flatMap((file) => offences(file, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });
});
