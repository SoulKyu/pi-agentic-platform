import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { indexBytes, isIndexDamaged, openSearchIndex } from "./index-db.ts";

describe("search.db", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-search-db-"));
    path = join(dir, "search.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const warnings = () => {
    const warn = vi.spyOn(silentLogger, "warn");
    return warn;
  };

  it("a new file gets the schema, schema_version 1 and synchronous NORMAL", () => {
    const db = openSearchIndex(path, silentLogger);
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe("1");
    expect(db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(1);
    expect(db.all("SELECT name FROM sqlite_master WHERE name IN ('files', 'rows', 'rows_fts')")).toHaveLength(
      3,
    );
    db.close();
  });

  it("deletes and rebuilds a file of another schema version, logging search_index_rebuilt", () => {
    const first = openSearchIndex(path, silentLogger);
    first.run(
      "INSERT INTO rows (path, session_id, owner_id, entry_id, role, at, text) VALUES ('p', 's', 'u', 'e', 'user', 1, 't')",
    );
    first.run("UPDATE meta SET value = '0' WHERE key = 'schema_version'");
    first.close();
    const warn = warnings();
    try {
      const db = openSearchIndex(path, silentLogger);
      expect(db.get("SELECT 1 FROM rows")).toBeUndefined();
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe(
        "1",
      );
      db.close();
      expect(warn.mock.calls).toEqual([["search_index_rebuilt", { reason: "version", from: 0 }]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("rebuilds a file that is not a database", () => {
    writeFileSync(path, "x".repeat(4096));
    const warn = warnings();
    try {
      const db = openSearchIndex(path, silentLogger);
      expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value).toBe(
        "1",
      );
      db.close();
      expect(warn.mock.calls).toEqual([["search_index_rebuilt", { reason: "damaged" }]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("recognises damage by SQLite code or message, and nothing else", () => {
    expect(isIndexDamaged({ errcode: 11 })).toBe(true);
    expect(isIndexDamaged({ errcode: 267 })).toBe(true);
    expect(isIndexDamaged({ errcode: 26 })).toBe(true);
    expect(isIndexDamaged(new Error("database disk image is malformed"))).toBe(true);
    expect(isIndexDamaged({ errcode: 5 })).toBe(false);
    expect(isIndexDamaged({ errcode: 19 })).toBe(false);
    expect(isIndexDamaged(new Error("boom"))).toBe(false);
    expect(isIndexDamaged(null)).toBe(false);
  });

  it("indexBytes is 0 for a missing path, else the file plus its -wal", () => {
    expect(indexBytes(path)).toBe(0);
    const db = openSearchIndex(path, silentLogger);
    db.run(
      "INSERT INTO rows (path, session_id, owner_id, entry_id, role, at, text) VALUES ('p', 's', 'u', 'e', 'user', 1, 't')",
    );
    const wal = statSync(`${path}-wal`).size;
    expect(wal).toBeGreaterThan(0);
    expect(indexBytes(path)).toBe(statSync(path).size + wal);
    db.close();
  });

  it("creates the file with mode 0600 under umask 077", () => {
    const previous = process.umask(0o077);
    try {
      openSearchIndex(path, silentLogger).close();
    } finally {
      process.umask(previous);
    }
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
