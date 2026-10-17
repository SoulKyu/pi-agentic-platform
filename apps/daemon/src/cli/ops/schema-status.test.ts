import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../../daemon.ts";
import { discoverMigrations } from "../../kernel/db/migrate.ts";
import { knownMigrationIds, schemaStatus } from "./schema-status.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-schema-"));
  path = join(dir, "state.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeDb(ids: string[], wal = false): DatabaseSync {
  const db = new DatabaseSync(path);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY) STRICT");
  for (const id of ids) db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
  return db;
}
const listing = () => readdirSync(dir).sort();

describe("schemaStatus", () => {
  it("absent: the file is not created", () => {
    expect(schemaStatus(path, new Set(["a"]))).toEqual({ state: "absent", ids: [] });
    expect(existsSync(path)).toBe(false);
    expect(listing()).toEqual([]);
  });
  it("damaged: a garbage file", () => {
    writeFileSync(path, "not a database ".repeat(40));
    expect(schemaStatus(path, new Set(["a"]))).toEqual({ state: "damaged", ids: [] });
  });
  it("current: ids equal known", () => {
    makeDb(["a", "b"]).close();
    expect(schemaStatus(path, new Set(["a", "b"]))).toEqual({ state: "current", ids: ["a", "b"] });
  });
  it("pending: ids are a strict subset", () => {
    makeDb(["a"]).close();
    expect(schemaStatus(path, new Set(["a", "b"]))).toEqual({ state: "pending", ids: ["a"] });
  });
  it("newer: an id the release does not know", () => {
    makeDb(["a", "z"]).close();
    expect(schemaStatus(path, new Set(["a", "b"]))).toEqual({ state: "newer", ids: ["a", "z"] });
  });
});

describe("schemaStatus with noWrite (M6b-RT-06)", () => {
  it("no lock, clean WAL database: current, and the folder listing is identical before and after", () => {
    makeDb(["a"], true).close();
    const before = listing();
    expect(before).toEqual(["state.db"]);
    expect(schemaStatus(path, new Set(["a"]), { noWrite: { lockHeld: false } })).toEqual({
      state: "current",
      ids: ["a"],
    });
    expect(listing()).toEqual(before);
  });
  it("no lock and a leftover -wal: unread, nothing is opened or created", () => {
    makeDb(["a"], true).close();
    writeFileSync(`${path}-wal`, "leftover log");
    const before = listing();
    expect(schemaStatus(path, new Set(["a"]), { noWrite: { lockHeld: false } })).toEqual({
      state: "unread",
      ids: [],
    });
    expect(listing()).toEqual(before);
  });
  it("lock held with a live writer: the ids are read and nothing new appears", () => {
    const writer = makeDb(["a"], true);
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE note (body TEXT)");
    const before = listing();
    expect(before).toContain("state.db-wal");
    try {
      expect(schemaStatus(path, new Set(["a", "b"]), { noWrite: { lockHeld: true } })).toEqual({
        state: "pending",
        ids: ["a"],
      });
      expect(listing()).toEqual(before);
    } finally {
      writer.close();
    }
  });
  it("noWrite on an absent database is absent", () => {
    expect(schemaStatus(path, new Set(["a"]), { noWrite: { lockHeld: false } })).toEqual({
      state: "absent",
      ids: [],
    });
    expect(listing()).toEqual([]);
  });
});

describe("knownMigrationIds", () => {
  it("is the ids of discoverMigrations(MIGRATION_SOURCES)", () => {
    const ids = knownMigrationIds();
    expect([...ids].sort()).toEqual(
      discoverMigrations(MIGRATION_SOURCES)
        .map((m) => m.id)
        .sort(),
    );
    expect(ids.has("kernel/202610100000_kernel.sql")).toBe(true);
  });
});
