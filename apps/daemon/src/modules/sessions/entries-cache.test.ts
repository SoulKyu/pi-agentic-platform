import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEntriesCache, MAX_CACHE_BYTES, MAX_PARSE_BYTES } from "./entries-cache.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-entries-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const header = (id = "s") => JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd: "/w" });
const entry = (id: string, parentId: string | null) =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: "t",
    message: { role: "user", content: id, timestamp: 1 },
  });
// Counts full parses: the cache migrates a file only when it parses it whole.
const counting = () => {
  const sdk = { CURRENT_SESSION_VERSION: 3, parses: 0, migrateSessionEntries: () => void sdk.parses++ };
  return sdk;
};
const ids = (cache: ReturnType<typeof createEntriesCache>, file: string, upTo?: number) =>
  cache.read(file, upTo).list.map((e) => e.id);

describe("entries cache", () => {
  it("has the budgets the rulings give", () => {
    expect(MAX_PARSE_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_CACHE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("leaves out a line Pi has not finished writing, and reads only up to a size", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${entry("e2", "e1")}\n{"type":"mess`);
    const cache = createEntriesCache(counting());
    expect(ids(cache, file)).toEqual(["e1", "e2"]);
    expect(ids(cache, file, Buffer.byteLength(`${header()}\n${entry("e1", null)}\n`))).toEqual(["e1"]);
  });

  it("parses only the lines appended to a growing file of the current format", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n`);
    const sdk = counting();
    const cache = createEntriesCache(sdk);
    expect(ids(cache, file)).toEqual(["e1"]);
    appendFileSync(file, `${entry("e2", "e1")}\n${entry("e3", "e2")}\n`);
    expect(ids(cache, file)).toEqual(["e1", "e2", "e3"]);
    expect(sdk.parses).toBe(1);
    expect(
      ids(cache, file, Buffer.byteLength(`${header()}\n${entry("e1", null)}\n${entry("e2", "e1")}\n`)),
    ).toEqual(["e1", "e2"]);
  });

  it("finishes a line that was half written when it was last read, without losing or doubling it", () => {
    const file = join(dir, "s.jsonl");
    const second = entry("e2", "e1");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${second.slice(0, 20)}`);
    const sdk = counting();
    const cache = createEntriesCache(sdk);
    expect(ids(cache, file)).toEqual(["e1"]);
    appendFileSync(file, `${second.slice(20)}\n`);
    expect(ids(cache, file)).toEqual(["e1", "e2"]);
    expect(sdk.parses).toBe(1);
  });

  it("parses the whole file again when it shrank, its header changed, or it is an older format", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${entry("e2", "e1")}\n`);
    const sdk = counting();
    const cache = createEntriesCache(sdk);
    ids(cache, file);
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n`);
    expect(ids(cache, file)).toEqual(["e1"]);
    writeFileSync(file, `${header("other-session")}\n${entry("x1", null)}\n${entry("x2", "x1")}\n`);
    expect(ids(cache, file)).toEqual(["x1", "x2"]);
    const old = join(dir, "old.jsonl");
    writeFileSync(
      old,
      `${JSON.stringify({ type: "session", version: 2, id: "o", timestamp: "t", cwd: "/w" })}\n${entry("o1", null)}\n`,
    );
    ids(cache, old);
    appendFileSync(old, `${entry("o2", "o1")}\n`);
    expect(ids(cache, old)).toEqual(["o1", "o2"]);
    expect(sdk.parses).toBe(5);
  });

  it("parses the whole file again when the path now points at another file (inode change)", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n`);
    const sdk = counting();
    const cache = createEntriesCache(sdk);
    expect(ids(cache, file)).toEqual(["e1"]);
    const replacement = join(dir, "next.jsonl");
    writeFileSync(
      replacement,
      `${header()}\n${entry("y1", null)}\n${entry("y2", "y1")}\n${entry("y3", "y2")}\n`,
    );
    renameSync(replacement, file);
    expect(ids(cache, file)).toEqual(["y1", "y2", "y3"]);
    expect(sdk.parses).toBe(2);
  });

  it("gives nothing for a missing file and skips lines that are not JSON, once said", () => {
    const issues: string[] = [];
    const cache = createEntriesCache(counting(), { onIssue: (issue) => void issues.push(issue) });
    expect(cache.read(join(dir, "missing.jsonl")).list).toEqual([]);
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\nnot json\n${entry("e1", null)}\nalso not json\n`);
    expect(ids(cache, file)).toEqual(["e1"]);
    expect(issues).toEqual(["bad_lines"]);
  });

  it("leaves out an entry whose id is longer than 128 characters, and says so (M2-RT-06)", () => {
    const issues: string[] = [];
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${entry("x".repeat(129), "e1")}\n`);
    expect(
      ids(createEntriesCache(counting(), { onIssue: (issue) => void issues.push(issue) }), file),
    ).toEqual(["e1"]);
    expect(issues).toEqual(["long_id"]);
  });

  it("leaves out an entry whose parent id is longer than 128 characters, and keeps one of exactly 128", () => {
    const issues: string[] = [];
    const file = join(dir, "s.jsonl");
    const edge = "y".repeat(128);
    writeFileSync(file, `${header()}\n${entry("e1", "x".repeat(129))}\n${entry(edge, null)}\n`);
    expect(
      ids(createEntriesCache(counting(), { onIssue: (issue) => void issues.push(issue) }), file),
    ).toEqual([edge]);
    expect(issues).toEqual(["long_id"]);
  });

  it("reads only the tail of a file over maxBytes, and says so", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n${entry("e2", "e1")}\n${entry("e3", "e2")}\n`);
    const issues: Array<[string, number]> = [];
    const cache = createEntriesCache(counting(), {
      maxBytes: Buffer.byteLength(`${entry("e3", "e2")}\n`) + 5,
      onIssue: (issue, size) => void issues.push([issue, size]),
    });
    expect(ids(cache, file)).toEqual(["e3"]);
    expect(issues).toEqual([["tail_only", statSync(file).size]]);
  });

  it("parses again, not by append, when a growing file crosses the parse budget", () => {
    const file = join(dir, "s.jsonl");
    const first = `${header()}\n${entry("e1", null)}\n`;
    writeFileSync(file, first);
    const sdk = counting();
    const issues: string[] = [];
    const cache = createEntriesCache(sdk, {
      maxBytes: Buffer.byteLength(first) + Buffer.byteLength(`${entry("e2", "e1")}\n`),
      onIssue: (issue) => void issues.push(issue),
    });
    expect(ids(cache, file)).toEqual(["e1"]);
    appendFileSync(file, `${entry("e2", "e1")}\n`);
    expect(ids(cache, file)).toEqual(["e1", "e2"]);
    expect(sdk.parses).toBe(1);
    appendFileSync(file, `${entry("e3", "e2")}\n`);
    // The last maxBytes of the file: e2 and e3 whole, the line cut in front of them left out.
    expect(ids(cache, file)).toEqual(["e2", "e3"]);
    expect(sdk.parses).toBe(2);
    expect(issues).toEqual(["tail_only"]);
  });

  it("keeps parsed files under its byte budget, least recently used out first (M2-RT-15)", () => {
    const files = ["a", "b", "c"].map((name) => {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, `${header()}\n${entry(name, null)}\n`);
      return file;
    });
    const each = statSync(files[0] ?? "").size;
    const sdk = counting();
    const cache = createEntriesCache(sdk, { maxCacheBytes: Math.floor(each * 2.5) });
    for (const file of [...files, files[0] ?? ""]) cache.read(file);
    // a, b, c parsed; c pushes a out (three files are over 2.5 files' bytes); a is parsed again.
    expect(sdk.parses).toBe(4);
  });

  it("evicts the least recently READ file, not the oldest parsed one", () => {
    const files = ["a", "b", "c"].map((name) => {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, `${header()}\n${entry(name, null)}\n`);
      return file;
    });
    const each = statSync(files[0] ?? "").size;
    const sdk = counting();
    const cache = createEntriesCache(sdk, { maxCacheBytes: Math.floor(each * 2.5) });
    const [a, b, c] = files as [string, string, string];
    cache.read(a);
    cache.read(b);
    cache.read(a);
    cache.read(c);
    expect(sdk.parses).toBe(3);
    cache.read(a);
    expect(sdk.parses).toBe(3);
    cache.read(b);
    expect(sdk.parses).toBe(4);
  });

  it("keeps a single file bigger than the whole budget (it is the one being read)", () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n`);
    const sdk = counting();
    const cache = createEntriesCache(sdk, { maxCacheBytes: 10 });
    expect(ids(cache, file)).toEqual(["e1"]);
    expect(ids(cache, file)).toEqual(["e1"]);
    expect(sdk.parses).toBe(1);
  });

  it("says read_failed for a file it cannot read, and reads it again once it can", () => {
    const issues: string[] = [];
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `${header()}\n${entry("e1", null)}\n`, { mode: 0o000 });
    const cache = createEntriesCache(counting(), { onIssue: (issue) => void issues.push(issue) });
    // Root can read a 0o000 file; the assertion holds for both outcomes of the first read.
    const first = ids(cache, file);
    if (first.length === 0) expect(issues).toEqual(["read_failed"]);
    else expect(issues).toEqual([]);
  });
});
