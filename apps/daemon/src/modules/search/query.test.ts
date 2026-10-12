import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { openSearchIndex } from "./index-db.ts";
import { createSearchIndexStore, type FileCursor, type SearchIndexStore } from "./index-store.ts";
import { QueryDeadlineError, RANK, runQuery } from "./query.ts";

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

  it("ranks sessions by bm25 and answers each session's best row", () => {
    commit("/s/weak.jsonl", "weak", "u1", [
      [
        "w1",
        "user",
        "one more word about kubernetes and then a very long tail of other words that dilute the match",
      ],
    ]);
    commit("/s/strong.jsonl", "strong", "u1", [
      ["x1", "user", "some padding words that are long and unrelated to the topic at hand here"],
      ["x2", "user", "kubernetes"],
      [
        "x3",
        "user",
        "a long reply that mentions kubernetes once among many other unrelated words in the sentence",
      ],
    ]);
    const rows = runQuery(reader, { match: '"kubernetes"', ownerId: "u1", limit: 20 });
    expect(rows.map((row) => [row.sessionId, row.entryId])).toEqual([
      ["strong", "x2"],
      ["weak", "w1"],
    ]);
  });

  it("snippets are owner-filtered too: a rowid of another owner never comes back", () => {
    commit("/s/a.jsonl", "s1", "u1", [["e1", "user", "kubernetes here"]]);
    commit("/s/c.jsonl", "s3", "u2", [["e4", "user", "kubernetes there"]]);
    const rows = runQuery(reader, { match: '"kubernetes"', ownerId: "u2", limit: 20 });
    expect(rows.map((row) => row.sessionId)).toEqual(["s3"]);
  });

  it("aborts a statement that outlives its deadline, from inside SQLite", () => {
    commit("/s/a.jsonl", "s1", "u1", [["e1", "user", "kubernetes here"]]);
    const input = { match: '"kubernetes"', ownerId: "u1", limit: 20 };
    expect(() => runQuery(reader, input, { at: 100, now: () => 100 })).toThrow(QueryDeadlineError);
    expect(runQuery(reader, input, { at: 101, now: () => 100 })).toHaveLength(1);
  });

  it("plans the FTS match as the outer loop, before the search of `rows` (quadratic otherwise)", () => {
    commit("/s/a.jsonl", "s1", "u1", [["e1", "user", "kubernetes here"]]);
    runQuery(reader, { match: '"kubernetes"', ownerId: "u1", limit: 20 });
    const plan = reader
      .prepare(`EXPLAIN QUERY PLAN ${RANK}`)
      .all({ match: '"kubernetes"', owner: "u1", limit: 20 })
      .map((row) => String((row as { detail: unknown }).detail));
    const fts = plan.findIndex((detail) => detail.includes("rows_fts VIRTUAL TABLE"));
    const rowsSearch = plan.findIndex((detail) => /^SEARCH r\b/.test(detail));
    expect(fts).toBeGreaterThanOrEqual(0);
    expect(rowsSearch).toBeGreaterThan(fts);
  });
});
