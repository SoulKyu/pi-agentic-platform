import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { MIGRATION_SOURCES } from "../../daemon.ts";
import { discoverMigrations } from "../../kernel/db/migrate.ts";

export type SchemaState = "absent" | "damaged" | "current" | "pending" | "newer" | "unread";

/** The migration ids this release carries (the daemon's own list, never a copy). */
export function knownMigrationIds(): ReadonlySet<string> {
  return new Set(discoverMigrations(MIGRATION_SOURCES).map((migration) => migration.id));
}

/**
 * Opens `state.db` so that nothing is created next to it. Lock held (the daemon runs, so its -shm and -wal exist): a plain
 * read-only connection. No lock and no -wal: the immutable URI (SQLite then neither looks for nor creates a -wal or -shm).
 * No lock and a leftover -wal: null, the log is applied at the next start and a read-only open would have to create a -shm.
 */
export function openNoWrite(dbPath: string, lockHeld: boolean): DatabaseSync | null {
  if (lockHeld) return new DatabaseSync(dbPath, { readOnly: true });
  if (existsSync(`${dbPath}-wal`)) return null;
  return new DatabaseSync(`${pathToFileURL(dbPath).href}?mode=ro&immutable=1`, { readOnly: true });
}

/**
 * Compares the migration ids of `state.db` with `known`, read-only. A missing file is `absent` and is never created.
 * With `noWrite` the database is opened as `openNoWrite` says and `unread` means it was not opened at all.
 */
export function schemaStatus(
  dbPath: string,
  known: ReadonlySet<string>,
  options: { noWrite?: { lockHeld: boolean } } = {},
): { state: SchemaState; ids: string[] } {
  if (!existsSync(dbPath)) return { state: "absent", ids: [] };
  let db: DatabaseSync | null | undefined;
  try {
    db =
      options.noWrite === undefined
        ? new DatabaseSync(dbPath, { readOnly: true })
        : openNoWrite(dbPath, options.noWrite.lockHeld);
    if (db === null) return { state: "unread", ids: [] };
    const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (check?.integrity_check !== "ok") return { state: "damaged", ids: [] };
    const rows = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[];
    const ids = rows.map((row) => row.id);
    if (ids.some((id) => !known.has(id))) return { state: "newer", ids };
    return { state: ids.length === known.size ? "current" : "pending", ids };
  } catch {
    return { state: "damaged", ids: [] };
  } finally {
    try {
      db?.close();
    } catch {
      // nothing left to do
    }
  }
}
