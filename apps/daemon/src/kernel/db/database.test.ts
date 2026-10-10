import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "./database.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-db-"));
  db = openDatabase(join(dir, "state.db"));
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("uses WAL, foreign keys and named parameters", () => {
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    db.run("INSERT INTO t (v) VALUES ($v)", { v: "a" });
    expect(db.all<{ v: string }>("SELECT v FROM t")).toEqual([{ v: "a" }]);
  });

  it("applies the durability settings of spec C 3.2", () => {
    expect(db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
    expect(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(5000);
    expect(db.get<{ journal_size_limit: number }>("PRAGMA journal_size_limit")?.journal_size_limit).toBe(
      32 * 1024 * 1024,
    );
  });

  it("commits a transaction and rolls it back on error", () => {
    db.transaction(() => db.run("INSERT INTO t (v) VALUES ('kept')"));
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES ('dropped')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.all<{ v: string }>("SELECT v FROM t").map((r) => r.v)).toEqual(["kept"]);
  });

  it("runs a nested transaction inline", () => {
    db.transaction(() => db.transaction(() => db.run("INSERT INTO t (v) VALUES ('n')")));
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM t")?.c).toBe(1);
  });

  it("rolls the outer transaction back when a nested one throws", () => {
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES ('outer')");
        db.transaction(() => {
          throw new Error("inner");
        });
      }),
    ).toThrow("inner");
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM t")?.c).toBe(0);
  });

  it("opens an existing database read-only and refuses writes", () => {
    db.run("INSERT INTO t (v) VALUES ('x')");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const reader = openDatabase(join(dir, "state.db"), { readOnly: true });
    expect(reader.readOnly).toBe(true);
    expect(db.readOnly).toBe(false);
    expect(reader.all<{ v: string }>("SELECT v FROM t")).toEqual([{ v: "x" }]);
    expect(() => reader.run("INSERT INTO t (v) VALUES ('y')")).toThrow();
    reader.close();
  });
});
