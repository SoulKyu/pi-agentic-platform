import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { sha256Hex } from "../ids.ts";
import { silentLogger, type Logger } from "../logger.ts";
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
    expect(result.snapshotPath).toBeNull();
    result.db.close();
  });

  it("does nothing the second time and snapshots before a later migration", () => {
    migrate(options([source("a", A1)])).db.close();
    const again = migrate(options([source("a", A1)]));
    expect(again.applied).toEqual([]);
    again.db.close();
    const later = migrate(options([source("a", { ...A1, ...A9 })]));
    expect(later.applied).toEqual(["a/202601010009_add.sql"]);
    expect(later.snapshotPath).toMatch(/pre-migrate-.+\.db$/);
    expect(existsSync(later.snapshotPath ?? "")).toBe(true);
    later.db.close();
  });

  it("takes the snapshot before the migration runs", () => {
    const first = migrate(options([source("a", A1)]));
    first.db.run("INSERT INTO a1 (id) VALUES (7)");
    first.db.close();
    const later = migrate(options([source("a", { ...A1, ...A9 })]));
    later.db.close();
    const copy = openDatabase(later.snapshotPath ?? "", { readOnly: true });
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

  it("snapshots a live WAL database consistently, rows not yet checkpointed included", () => {
    const dbPath = join(root, "state.db");
    const writer = migrate(options([source("a", A1)]));
    writer.db.run("INSERT INTO a1 (id) VALUES (1)");
    writer.db.run("INSERT INTO a1 (id) VALUES (2)");
    const reader = openDatabase(dbPath);
    reader.exec("BEGIN");
    reader.get("SELECT count(*) AS c FROM a1");
    writer.db.run("INSERT INTO a1 (id) VALUES (3)");
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
    const later = migrate(options([source("a", { ...A1, ...A9 })]));
    const copy = openDatabase(later.snapshotPath ?? "", { readOnly: true });
    expect(copy.all("SELECT id FROM a1 ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(copy.all<{ name: string }>("SELECT name FROM pragma_table_info('a1')").map((c) => c.name)).toEqual(
      ["id"],
    );
    copy.close();
    reader.exec("ROLLBACK");
    reader.close();
    writer.db.close();
    later.db.close();
  });

  it("writes one private file into backups and nothing else", () => {
    migrate(options([source("a", A1)])).db.close();
    const later = migrate(options([source("a", { ...A1, ...A9 })]));
    later.db.close();
    expect(readdirSync(join(root, "backups"))).toEqual([basename(later.snapshotPath ?? "")]);
    expect(statSync(later.snapshotPath ?? "").mode & 0o777).toBe(0o600);
  });

  it("removes the temporary snapshot when it cannot be completed", () => {
    migrate(options([source("a", A1)])).db.close();
    const stamp = new Date(1_700_000_000_000).toISOString().replace(/[:.]/g, "-");
    const target = join(root, "backups", `pre-migrate-${stamp}.db`);
    mkdirSync(join(target, "occupied"), { recursive: true });
    expect(() => migrate(options([source("a", { ...A1, ...A9 })]))).toThrow(MigrationError);
    expect(readdirSync(join(root, "backups"))).toEqual([basename(target)]);
  });

  it("refuses a migration file edited after it was applied", () => {
    const a = source("a", A1);
    migrate(options([a])).db.close();
    writeFileSync(join(a.dir, "202601010001_one.sql"), "CREATE TABLE a1 (id INTEGER, marker_secret TEXT);");
    const attempt = () => migrate(options([a]));
    expect(attempt).toThrow(MigrationError);
    expect(attempt).toThrow("migration file changed after it was applied: a/202601010001_one.sql");
    expect(attempt).not.toThrow(/marker_secret/);
  });

  it("refuses a pending migration that sorts before an applied one", () => {
    const a = source("a", { ...A1, ...A9 });
    migrate(options([a])).db.close();
    writeFileSync(join(a.dir, "202601010005_mid.sql"), "ALTER TABLE a1 ADD COLUMN mid TEXT;");
    expect(() => migrate(options([a]))).toThrow(
      "migration a/202601010005_mid.sql sorts before an applied migration",
    );
    rmSync(join(a.dir, "202601010005_mid.sql"));
    const reopened = migrate(options([a]));
    expect(reopened.applied).toEqual([]);
    reopened.db.close();
  });

  it("refuses a pending migration that ties on stamp but sorts before an applied module", () => {
    const b = source("b", { "202601010009_b.sql": "CREATE TABLE b9 (id INTEGER PRIMARY KEY) STRICT;" });
    migrate(options([b])).db.close();
    const a = source("a", { "202601010009_a.sql": "CREATE TABLE a9 (id INTEGER PRIMARY KEY) STRICT;" });
    expect(() => migrate(options([b, a]))).toThrow(MigrationError);
  });

  it("orders migrations with the same stamp by module name and applies both", () => {
    const b = source("b", { "202601010009_b.sql": "CREATE TABLE b9 (id INTEGER PRIMARY KEY) STRICT;" });
    const a = source("a", { "202601010009_a.sql": "CREATE TABLE a9 (id INTEGER PRIMARY KEY) STRICT;" });
    const result = migrate(options([b, a]));
    expect(result.applied).toEqual(["a/202601010009_a.sql", "b/202601010009_b.sql"]);
    result.db.close();
  });

  it("skips a migration another process applied while this one was starting", () => {
    const a = source("a", A1);
    migrate(options([a])).db.close();
    const [file, sql] = Object.entries(A9)[0] ?? ["", ""];
    writeFileSync(join(a.dir, file), sql);
    const racing: Logger = {
      ...silentLogger,
      info: (msg) => {
        if (msg !== "pre_migration_snapshot") return;
        const other = openDatabase(join(root, "state.db"));
        other.exec(sql);
        other.run("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ($id, $sum, 1)", {
          id: `a/${file}`,
          sum: sha256Hex(sql),
        });
        other.close();
      },
    };
    const result = migrate({ ...options([a]), logger: racing });
    expect(result.applied).toEqual([]);
    expect(result.db.all("SELECT id FROM schema_migrations")).toHaveLength(2);
    result.db.close();
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
    expect(older.snapshotPath).toBeNull();
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
    expect(applied).toEqual(["kernel/202610100000_kernel.sql", "kernel/202610142000_outbox.sql"]);
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
