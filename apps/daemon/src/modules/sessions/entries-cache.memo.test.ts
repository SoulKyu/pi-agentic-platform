import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntriesCache } from "./entries-cache.ts";
import { sessionFileText } from "./testing/pi-file-writers.ts";

const sdk = { CURRENT_SESSION_VERSION: 3, migrateSessionEntries: () => {} };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-entries-memo-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe("entries cache memo for bounded reads", () => {
  it("hands out the same index for repeated bounded reads of an unchanged file", () => {
    const path = write(
      "s.jsonl",
      sessionFileText("p1", [
        ["hi", "hello"],
        ["again", "yes"],
      ]),
    );
    const cache = createEntriesCache(sdk);
    const bound = statSync(path).size - 10;
    const first = cache.read(path, bound);
    expect(cache.read(path, bound)).toBe(first);
    expect(cache.read(path, bound - 1)).not.toBe(first);
    expect(cache.read(path)).toBe(cache.read(path));
  });

  it("drops the memo when the file grows", () => {
    const path = write("s.jsonl", sessionFileText("p1", [["hi", "hello"]]));
    const cache = createEntriesCache(sdk);
    const bound = statSync(path).size;
    const first = cache.read(path, bound);
    appendFileSync(
      path,
      `${JSON.stringify({ type: "message", id: "u9", parentId: "a0", timestamp: "2026-10-10T00:00:09.000Z", message: { role: "user", content: "more", timestamp: 9 } })}\n`,
    );
    expect(cache.read(path, bound)).not.toBe(first);
    expect(cache.read(path, bound).list.map((e) => e.id)).toEqual(first.list.map((e) => e.id));
  });
});
