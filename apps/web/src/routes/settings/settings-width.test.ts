import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FEATURES = join(import.meta.dirname, "..", "..", "features");
const COLUMN_FEATURES = ["agents", "github", "health", "notifications", "skills", "usage", "users"];
const CAPS = /\bmax-w-(xl|prose|2xl|3xl|4xl)\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

describe("Settings column width", () => {
  it("no column section caps its own width: the body gives max-w-settings", () => {
    const capped = COLUMN_FEATURES.flatMap((name) => sources(join(FEATURES, name))).filter((file) =>
      CAPS.test(readFileSync(file, "utf8")),
    );
    expect(capped.map((file) => file.slice(FEATURES.length + 1))).toEqual([]);
  });
});
