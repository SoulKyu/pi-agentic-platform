import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore, type FileCursor, type SearchIndexStore } from "./index-store.ts";
import { runQuery } from "./query.ts";

type Row = [entryId: string, role: "user" | "assistant", text: string];

describe("runQuery", () => {
  let dir: string;
  let db: Db;
  let store: SearchIndexStore;
  let reader: DatabaseSync;

  const commit = (path: string, sessionId: string, ownerId: string, rows: Row[]) => {
    const cursor: FileCursor = {
      path,
      ino: 1,
      size: 200,
      mtimeMs: 5,
      offset: 100,
      skipLine: false,
      head: "{}",
      state: "indexed",
      sessionId,
      ownerId,
      indexedChars: 0,
    };
    db.transaction(() =>
      store.commit(
        cursor,
        rows.map(([entryId, role, text], i) => ({ entryId, role, at: i + 1, text })),
      ),
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-search-query-"));
    db = openSearchIndex(join(dir, "search.db"), silentLogger);
    store = createSearchIndexStore(db);
    reader = new DatabaseSync(join(dir, "search.db"), { readOnly: true });
  });

  afterEach(() => {
    reader.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers the best row of each of the caller's sessions, with marked snippets", () => {
    commit("/s/a.jsonl", "s1", "u1", [
      ["e1", "user", "deploy the kubernetes cluster"],
      ["e2", "assistant", "kubernetes is ready"],
    ]);
    commit("/s/b.jsonl", "s2", "u1", [["e3", "user", "a cafe near the cluster"]]);
    commit("/s/c.jsonl", "s3", "u2", [["e4", "user", "kubernetes for someone else"]]);
    const rows = runQuery(reader, { match: '"kubernetes"', ownerId: "u1", limit: 20 });
    expect(rows.map((row) => row.sessionId)).toEqual(["s1"]);
    expect(rows[0]?.snippet).toContain("\u0002kubernetes\u0003");
    expect(runQuery(reader, { match: '"cluster"', ownerId: "u1", limit: 1 })).toHaveLength(1);
  });

  it("never answers another owner's rows", () => {
    commit("/s/c.jsonl", "s3", "u2", [["e4", "user", "kubernetes for someone else"]]);
    expect(runQuery(reader, { match: '"kubernetes"', ownerId: "u1", limit: 20 })).toEqual([]);
  });

  it("gives one place to a session with hundreds of matching rows (RT-06)", () => {
    commit(
      "/s/heavy.jsonl",
      "heavy",
      "u1",
      Array.from({ length: 300 }, (_, i): Row => [`h${i}`, "user", `kubernetes kubernetes row ${i}`]),
    );
    for (let s = 0; s < 5; s++)
      commit(`/s/l${s}.jsonl`, `light${s}`, "u1", [[`l${s}`, "user", `a note about kubernetes number ${s}`]]);
    const rows = runQuery(reader, { match: '"kubernetes"', ownerId: "u1", limit: 20 });
    expect(rows.map((row) => row.sessionId).sort()).toEqual([
      "heavy",
      "light0",
      "light1",
      "light2",
      "light3",
      "light4",
    ]);
    expect(new Set(rows.map((row) => row.sessionId)).size).toBe(6);
  });
});
