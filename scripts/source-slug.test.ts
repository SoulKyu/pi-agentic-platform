import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const SLUG = /SoulKyu\/pi-agentic-platform/; // case kept: "@soulkyu/..." is the npm scope
const SKIP_DIR = new Set(["node_modules", "dist", "fixtures", ".worktrees", ".git", "docs"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIR.has(entry.name) ? [] : sources(join(dir, entry.name));
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [];
  });
}

describe("the project repository slug (AGPL section 13 link, update feed)", () => {
  it("is written once, in packages/contracts/src/source.ts", () => {
    const offenders = ["apps", "packages", "scripts"]
      .flatMap((top) => sources(join(root, top)))
      .filter((file) => SLUG.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));
    expect(offenders).toEqual(["packages/contracts/src/source.ts"]);
  });
});
