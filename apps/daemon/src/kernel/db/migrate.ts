import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { openDatabase, type Db } from "./database.ts";

export interface MigrationSource {
  readonly module: string;
  readonly dir: string;
}

interface Migration {
  readonly id: string;
  readonly stamp: string;
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

export function discoverMigrations(sources: readonly MigrationSource[]): Migration[] {
  const found: Migration[] = [];
  for (const source of sources) {
    for (const file of readdirSync(source.dir).sort()) {
      if (!file.endsWith(".sql")) continue;
      const match = FILE_RE.exec(file);
      if (!match?.[1]) throw new MigrationError(`bad migration file name ${source.module}/${file}`);
      found.push({
        id: `${source.module}/${file}`,
        stamp: match[1],
        sql: readFileSync(join(source.dir, file), "utf8"),
      });
    }
  }
  return found.sort((a, b) => a.stamp.localeCompare(b.stamp) || a.id.localeCompare(b.id));
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
  readonly snapshotDir: string | null;
  readonly readOnly: boolean;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function migrate(options: MigrateOptions): MigrateResult {
  const migrations = discoverMigrations(options.sources);
  const existed = existsSync(options.dbPath) && statSync(options.dbPath).size > 0;
  const db = openDatabase(options.dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT",
  );
  const applied = new Set(db.all<{ id: string }>("SELECT id FROM schema_migrations").map((row) => row.id));
  const known = new Set(migrations.map((migration) => migration.id));
  const unknown = [...applied].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    db.close();
    options.logger.warn("database_newer_than_binary", { unknown });
    return {
      db: openDatabase(options.dbPath, { readOnly: true }),
      applied: [],
      snapshotDir: null,
      readOnly: true,
    };
  }
  const pending = migrations.filter((migration) => !applied.has(migration.id));
  if (pending.length === 0) return { db, applied: [], snapshotDir: null, readOnly: false };
  let snapshotDir: string | null = null;
  if (existed) {
    try {
      snapshotDir = snapshot(db, options);
    } catch (error) {
      db.close();
      throw new MigrationError(`pre-migration snapshot failed: ${reason(error)}`, { cause: error });
    }
  }
  for (const migration of pending) {
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.run("INSERT INTO schema_migrations (id, applied_at) VALUES ($id, $at)", {
          id: migration.id,
          at: options.clock.now(),
        });
      });
    } catch (error) {
      db.close();
      throw new MigrationError(`migration ${migration.id} failed: ${reason(error)}`, { cause: error });
    }
    options.logger.info("migration_applied", { id: migration.id });
  }
  return { db, applied: pending.map((migration) => migration.id), snapshotDir, readOnly: false };
}

function snapshot(db: Db, options: MigrateOptions): string {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const stamp = new Date(options.clock.now()).toISOString().replace(/[:.]/g, "-");
  const dir = join(options.backupsDir, `pre-migrate-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${options.dbPath}${suffix}`;
    if (existsSync(file)) copyFileSync(file, join(dir, `state.db${suffix}`));
  }
  options.logger.info("pre_migration_snapshot", { dir });
  return dir;
}
