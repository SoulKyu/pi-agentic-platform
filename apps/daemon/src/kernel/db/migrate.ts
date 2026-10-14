import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../clock.ts";
import { sha256Hex } from "../ids.ts";
import type { Logger } from "../logger.ts";
import { openDatabase, type Db } from "./database.ts";

export interface MigrationSource {
  readonly module: string;
  readonly dir: string;
}

interface Migration {
  readonly id: string;
  readonly module: string;
  readonly stamp: string;
  readonly checksum: string;
  readonly sql: string;
}

export const KERNEL_MIGRATIONS: MigrationSource = {
  module: "kernel",
  dir: fileURLToPath(new URL("../migrations/", import.meta.url)),
};
const FILE_RE = /^(\d{12})_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {
  override name = "MigrationError";
}

// Plain code-unit comparison: the order of migrations must not depend on the locale.
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareMigrations = (a: Migration, b: Migration): number =>
  compareText(a.stamp, b.stamp) || compareText(a.module, b.module) || compareText(a.id, b.id);

export function discoverMigrations(sources: readonly MigrationSource[]): Migration[] {
  const found: Migration[] = [];
  for (const source of sources) {
    for (const file of readdirSync(source.dir).sort()) {
      if (!file.endsWith(".sql")) continue;
      const match = FILE_RE.exec(file);
      if (!match?.[1]) throw new MigrationError(`bad migration file name ${source.module}/${file}`);
      const bytes = readFileSync(join(source.dir, file));
      found.push({
        id: `${source.module}/${file}`,
        module: source.module,
        stamp: match[1],
        checksum: sha256Hex(bytes),
        sql: bytes.toString("utf8"),
      });
    }
  }
  return found.sort(compareMigrations);
}

export interface MigrateOptions {
  readonly dbPath: string;
  readonly backupsDir: string;
  readonly sources: readonly MigrationSource[];
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface MigrateResult {
  readonly db: Db;
  readonly applied: string[];
  readonly snapshotPath: string | null;
  readonly readOnly: boolean;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function refuse(db: Db, message: string, options?: ErrorOptions): never {
  db.close();
  throw new MigrationError(message, options);
}

const hasContent = (path: string): boolean => existsSync(path) && statSync(path).size > 0;

export function migrate(options: MigrateOptions): MigrateResult {
  const migrations = discoverMigrations(options.sources);
  const existed = hasContent(options.dbPath) || hasContent(`${options.dbPath}-wal`);
  const db = openDatabase(options.dbPath, { logger: options.logger });
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
  );
  const rows = db.all<{ id: string; checksum: string }>("SELECT id, checksum FROM schema_migrations");
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  const unknown = rows.map((row) => row.id).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    db.close();
    options.logger.warn("database_newer_than_binary", { unknown });
    return {
      db: openDatabase(options.dbPath, { readOnly: true }),
      applied: [],
      snapshotPath: null,
      readOnly: true,
    };
  }
  for (const row of rows) {
    if (known.get(row.id)?.checksum !== row.checksum) {
      refuse(db, `migration file changed after it was applied: ${row.id}`);
    }
  }
  const applied = new Set(rows.map((row) => row.id));
  const pending = migrations.filter((migration) => !applied.has(migration.id));
  const lastApplied = migrations.findLast((migration) => applied.has(migration.id));
  const late = pending.find((migration) => lastApplied && compareMigrations(migration, lastApplied) < 0);
  if (late) refuse(db, `migration ${late.id} sorts before an applied migration`);
  if (pending.length === 0) return { db, applied: [], snapshotPath: null, readOnly: false };
  let snapshotPath: string | null = null;
  if (existed) {
    try {
      snapshotPath = snapshot(db, options);
    } catch (error) {
      refuse(db, `pre-migration snapshot failed: ${reason(error)}`, { cause: error });
    }
  }
  const appliedNow: string[] = [];
  for (const migration of pending) {
    let ran = false;
    try {
      ran = applyOne(db, migration, options.clock);
    } catch (error) {
      refuse(db, `migration ${migration.id} failed: ${reason(error)}`, { cause: error });
    }
    if (!ran) continue;
    appliedNow.push(migration.id);
    options.logger.info("migration_applied", { id: migration.id });
  }
  return { db, applied: appliedNow, snapshotPath, readOnly: false };
}

// Re-checked under the write lock: another process may have applied it since the pending list was read.
function applyOne(db: Db, migration: Migration, clock: Clock): boolean {
  return db.transaction(() => {
    if (db.get("SELECT 1 AS found FROM schema_migrations WHERE id = $id", { id: migration.id })) return false;
    db.exec(migration.sql);
    db.run("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ($id, $checksum, $at)", {
      id: migration.id,
      checksum: migration.checksum,
      at: clock.now(),
    });
    return true;
  });
}

// VACUUM INTO writes one transactionally consistent file whatever the WAL holds and whichever
// connections are open; a raw copy of db + wal + shm is only consistent when a checkpoint succeeded.
function snapshot(db: Db, options: MigrateOptions): string {
  const stamp = new Date(options.clock.now()).toISOString().replace(/[:.]/g, "-");
  const path = join(options.backupsDir, `pre-migrate-${stamp}.db`);
  const temp = `${path}.tmp`;
  mkdirSync(options.backupsDir, { recursive: true, mode: 0o700 });
  try {
    rmSync(temp, { force: true });
    db.run("VACUUM INTO $path", { path: temp });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  options.logger.info("pre_migration_snapshot", { path });
  return path;
}
