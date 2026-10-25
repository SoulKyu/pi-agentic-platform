import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

describe("summaries", () => {
  it("every summary in apps/web carries the focus ring", () => {
    const offenders: string[] = [];
    for (const file of sources(import.meta.dirname)) {
      for (const [tag] of readFileSync(file, "utf8").matchAll(/<summary\b[^>]*>/g)) {
        if (!/focus-ring|FOCUS_RING/.test(tag)) offenders.push(`${file}: ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
