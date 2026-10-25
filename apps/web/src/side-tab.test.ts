import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const quoted = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

describe("side tabs", () => {
  it("no class list in apps/web pairs rounded-sm with border-l-2", () => {
    const offenders: string[] = [];
    for (const file of sources(import.meta.dirname)) {
      for (const [, , text] of readFileSync(file, "utf8").matchAll(quoted)) {
        if (text?.includes("rounded-sm") && text.includes("border-l-2")) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
