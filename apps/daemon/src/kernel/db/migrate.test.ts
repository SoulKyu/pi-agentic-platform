import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { openDatabase } from "./database.ts";
import { ensureInstallTimestamp } from "./meta.ts";
import { KERNEL_MIGRATIONS, migrate, MigrationError, type MigrationSource } from "./migrate.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-migrate-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function source(module: string, files: Record<string, string>): MigrationSource {
  const dir = join(root, "src", module);
  mkdirSync(dir, { recursive: true });
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return { module, dir };
}
const options = (sources: MigrationSource[]) => ({
  dbPath: join(root, "state.db"),
  backupsDir: join(root, "backups"),
  sources,
  clock: createFakeClock(),
  logger: silentLogger,
});
const A1 = { "202601010001_one.sql": "CREATE TABLE a1 (id INTEGER PRIMARY KEY) STRICT;" };
const B2 = { "202601010002_two.sql": "CREATE TABLE b2 (id INTEGER PRIMARY KEY) STRICT;" };
const A9 = { "202601010009_add.sql": "ALTER TABLE a1 ADD COLUMN w TEXT;" };

describe("migrate", () => {
  it("applies every module's migrations in timestamp order on a fresh database, without a snapshot", () => {
    const a = source("a", { ...A1, "202601010003_three.sql": "ALTER TABLE a1 ADD COLUMN v TEXT;" });
    const result = migrate(options([source("b", B2), a]));
    expect(result.applied).toEqual([
      "a/202601010001_one.sql",
      "b/202601010002_two.sql",
      "a/202601010003_three.sql",
    ]);
    expect(result.snapshotDir).toBeNull();
    result.db.close();
  });

  it("does nothing the second time and snapshots before a later migration", () => {
    migrate(options([source("a", A1)])).db.close();
    const again = migrate(options([source("a", A1)]));
    expect(again.applied).toEqual([]);
    again.db.close();
    const later = migrate(options([source("a", { ...A1, ...A9 })]));
    expect(later.applied).toEqual(["a/202601010009_add.sql"]);
    expect(later.snapshotDir).not.toBeNull();
    expect(existsSync(join(later.snapshotDir ?? "", "state.db"))).toBe(true);
    later.db.close();
  });

  it("takes the snapshot before the migration runs", () => {
    const first = migrate(options([source("a", A1)]));
    first.db.run("INSERT INTO a1 (id) VALUES (7)");
    first.db.close();
    const later = migrate(options([source("a", { ...A1, ...A9 })]));
    later.db.close();
    const copy = openDatabase(join(later.snapshotDir ?? "", "state.db"), { readOnly: true });
    expect(copy.all<{ id: number }>("SELECT id FROM a1")).toEqual([{ id: 7 }]);
    expect(copy.all<{ name: string }>("SELECT name FROM pragma_table_info('a1')").map((c) => c.name)).toEqual(
      ["id"],
    );
    copy.close();
  });

  it("refuses to migrate when the snapshot cannot be written", () => {
    migrate(options([source("a", A1)])).db.close();
    writeFileSync(join(root, "backups"), "not a directory");
    const later = source("a", { ...A1, ...A9 });
    expect(() => migrate(options([later]))).toThrow(MigrationError);
    const untouched = openDatabase(join(root, "state.db"), { readOnly: true });
    expect(untouched.all("SELECT id FROM schema_migrations")).toHaveLength(1);
    untouched.close();
    rmSync(join(root, "backups"));
    const retried = migrate(options([later]));
    expect(retried.applied).toEqual(["a/202601010009_add.sql"]);
    retried.db.close();
  });

  it("rolls back a failing migration and refuses to continue", () => {
    const broken = source("a", { ...A1, "202601010002_bad.sql": "CREATE TABLE broken (" });
    expect(() => migrate(options([broken]))).toThrow(MigrationError);
    rmSync(join(broken.dir, "202601010002_bad.sql"));
    const reopened = migrate(options([broken]));
    expect(reopened.applied).toEqual([]);
    expect(reopened.db.get("SELECT name FROM sqlite_master WHERE name = 'broken'")).toBeUndefined();
    reopened.db.close();
  });

  it("rolls back the statements of a failing file that ran before the error", () => {
    const sql = "CREATE TABLE half (id INTEGER PRIMARY KEY) STRICT; INSERT INTO missing VALUES (1);";
    const halfway = source("a", { ...A1, "202601010002_half.sql": sql });
    expect(() => migrate(options([halfway]))).toThrow(MigrationError);
    rmSync(join(halfway.dir, "202601010002_half.sql"));
    const reopened = migrate(options([halfway]));
    expect(reopened.db.get("SELECT name FROM sqlite_master WHERE name = 'half'")).toBeUndefined();
    reopened.db.close();
  });

  it("opens a database written by a newer binary read-only", () => {
    migrate(options([source("a", A1), source("b", B2)])).db.close();
    const older = migrate(options([source("a", A1)]));
    expect(older.readOnly).toBe(true);
    expect(older.snapshotDir).toBeNull();
    expect(() => older.db.run("INSERT INTO a1 (id) VALUES (1)")).toThrow();
    older.db.close();
  });

  it("rejects a badly named migration file", () => {
    expect(() => migrate(options([source("a", { "1_bad.sql": "SELECT 1;" })]))).toThrow(MigrationError);
  });

  it("records the install timestamp once", () => {
    const { db } = migrate(
      options([
        source("kernel", {
          "202601010000_meta.sql": "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
        }),
      ]),
    );
    const clock = createFakeClock(42);
    expect(ensureInstallTimestamp(db, clock)).toBe(42);
    expect(ensureInstallTimestamp(db, createFakeClock(99))).toBe(42);
    db.close();
  });

  it("ships a kernel migration that creates meta and receipts", () => {
    const { db, applied } = migrate(options([KERNEL_MIGRATIONS]));
    expect(applied).toEqual(["kernel/202610100000_kernel.sql"]);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["meta", "receipts", "schema_migrations"]),
    );
    db.close();
    expect(readFileSync(join(KERNEL_MIGRATIONS.dir, "202610100000_kernel.sql"), "utf8")).toContain(
      "receipts",
    );
  });
});
