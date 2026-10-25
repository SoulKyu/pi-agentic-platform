import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".ts") && !/\.test\.ts$|\/testing\//.test(join(dir, entry.name))
        ? [join(dir, entry.name)]
        : [],
  );

describe("one source of a user's role (M14)", () => {
  it('non-test daemon code has no caller.role and no role: "owner" literal', () => {
    const hits = walk(SRC).filter((file) => {
      const text = readFileSync(file, "utf8");
      return /\bcaller\.role\b/.test(text) || /\brole:\s*"owner"/.test(text);
    });
    expect(hits.map((file) => file.slice(SRC.length + 1))).toEqual([]);
  });
});
