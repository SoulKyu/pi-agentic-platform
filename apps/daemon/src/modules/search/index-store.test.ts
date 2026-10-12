import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { openSearchIndex } from "./index-db.ts";
import {
  createSearchIndexStore,
  type FileCursor,
  indexText,
  MAX_ROW_CHARS,
  type SearchIndexStore,
} from "./index-store.ts";

const cursor = (path: string, patch: Partial<FileCursor> = {}): FileCursor => ({
  path,
  ino: 1,
  size: 200,
  mtimeMs: 5,
  offset: 100,
  skipLine: false,
  head: "{}",
  state: "indexed",
  sessionId: "s1",
  ownerId: "u1",
  indexedChars: 0,
  ...patch,
});

describe("search index store", () => {
  let dir: string;
  let db: Db;
  let store: SearchIndexStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-search-store-"));
    db = openSearchIndex(join(dir, "search.db"), silentLogger);
    store = createSearchIndexStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("commits rows and their cursor together, and finds them through FTS5 with diacritics folded", () => {
    store.commit(cursor("/s/a.jsonl", { sessionId: "s1", ownerId: "u1", offset: 120 }), [
      { entryId: "e1", role: "user", at: 1, text: "Déployer le cluster kubernetes" },
      { entryId: "e2", role: "assistant", at: 2, text: "Le café est prêt" },
    ]);
    expect(store.cursor("/s/a.jsonl")).toMatchObject({
      offset: 120,
      skipLine: false,
      state: "indexed",
      sessionId: "s1",
    });
    const hits = db.all<{ entry_id: string }>(
      "SELECT r.entry_id FROM rows_fts JOIN rows r ON r.id = rows_fts.rowid WHERE rows_fts MATCH '\"cafe\"'",
    );
    expect(hits.map((hit) => hit.entry_id)).toEqual(["e2"]);
    expect(store.rowCount()).toBe(2);
  });

  it("forget removes a file's rows from the index and its cursor", () => {
    store.commit(cursor("/s/a.jsonl"), [{ entryId: "e1", role: "user", at: 1, text: "alpha" }]);
    store.commit(cursor("/s/b.jsonl"), [{ entryId: "e9", role: "user", at: 1, text: "alpha" }]);
    store.forget("/s/a.jsonl");
    expect(store.cursor("/s/a.jsonl")).toBeUndefined();
    expect(db.all("SELECT rowid FROM rows_fts WHERE rows_fts MATCH '\"alpha\"'")).toHaveLength(1);
    expect(store.paths()).toEqual(["/s/b.jsonl"]);
  });

  it("lists a folder's cursors in one query, and keeps a skipped line's flag", () => {
    store.commit(cursor("/s/f/a.jsonl", { skipLine: true }), []);
    store.commit(cursor("/s/f/b.jsonl"), []);
    store.commit(cursor("/s/g/c.jsonl"), []);
    expect([...store.cursorsIn("/s/f").keys()].sort()).toEqual(["/s/f/a.jsonl", "/s/f/b.jsonl"]);
    expect(store.cursorsIn("/s/f").get("/s/f/a.jsonl")?.skipLine).toBe(true);
  });

  it("refuses rows on a cursor that names no session", () => {
    expect(() =>
      store.commit(cursor("/s/a.jsonl", { sessionId: null }), [
        { entryId: "e1", role: "user", at: 1, text: "x" },
      ]),
    ).toThrow();
    expect(store.cursor("/s/a.jsonl")).toBeUndefined();
  });
});

describe("indexText", () => {
  it("turns controls (the snippet markers included) into spaces, drops format characters, cuts without splitting a pair", () => {
    expect(indexText("a\u0002b\u0003c\u0000d\u001be")).toBe("a b c d e");
    expect(indexText("left\u202Eright\u200B!")).toBe("leftright!");
    expect(indexText("tab\tand\nline")).toBe("tab\tand\nline");
    expect(indexText("\u{1F469}\u200D\u{1F4BB}")).toBe("\u{1F469}\u200D\u{1F4BB}");
    const long = `${"a".repeat(MAX_ROW_CHARS - 1)}\u{1F600}`;
    expect(indexText(long)).toBe("a".repeat(MAX_ROW_CHARS - 1));
  });
});
