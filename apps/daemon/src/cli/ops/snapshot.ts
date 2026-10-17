import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export class SnapshotError extends Error {
  override name = "SnapshotError";
}

export interface SnapshotOptions {
  /** The caller holds the instance lock: no daemon can be starting, so a sidecar this call made may be removed. */
  readonly held?: boolean;
  /** Test seam: runs after the first `VACUUM INTO`, while the connection is still open (a daemon starting). */
  readonly whileOpen?: () => void;
}

/**
 * `VACUUM INTO` from a read-only connection: one consistent file whatever the WAL holds, with the daemon running or not.
 * With no -wal and no -shm (no daemon, cleanly closed) the immutable URI is used, so SQLite creates neither; if a sidecar
 * appears while it reads (a daemon started), the read may be torn and is redone through a plain read-only connection.
 * A sidecar is never removed unless the caller holds the instance lock (`held`) and this call made it: without the lock
 * a file next to the database may belong to a live daemon. The output is created 0600 before SQLite writes to it.
 */
export function snapshotDatabase(dbPath: string, outPath: string, options: SnapshotOptions = {}): void {
  if (existsSync(outPath)) throw new SnapshotError("the snapshot file exists");
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  const temp = `${outPath}.tmp`;
  rmSync(temp, { force: true });
  const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`];
  const existed = sidecars.map((path) => existsSync(path));
  let db: DatabaseSync | undefined;
  const vacuum = (immutable: boolean): void => {
    db = immutable
      ? new DatabaseSync(`${pathToFileURL(dbPath).href}?mode=ro&immutable=1`, { readOnly: true })
      : new DatabaseSync(dbPath, { readOnly: true });
    db.prepare("VACUUM INTO ?").run(temp);
    options.whileOpen?.();
    db.close();
    db = undefined;
  };
  try {
    closeSync(openSync(temp, "wx", 0o600)); // VACUUM INTO accepts an empty file
    const immutable = !existed.some(Boolean);
    vacuum(immutable);
    if (immutable && sidecars.some((path) => existsSync(path))) {
      rmSync(temp, { force: true });
      closeSync(openSync(temp, "wx", 0o600));
      vacuum(false);
    }
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, outPath);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // the original error is the one to report
    }
    rmSync(temp, { force: true });
    throw new SnapshotError(`snapshot failed: ${(error as { code?: string }).code ?? "error"}`);
  } finally {
    if (options.held === true)
      sidecars.forEach((path, index) => {
        if (!existed[index]) rmSync(path, { force: true });
      });
  }
}

/** The migration ids a database holds, or null when it cannot be read or is damaged. */
export function schemaIds(dbPath: string): string[] | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (check?.integrity_check !== "ok") return null;
    const rows = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[];
    return rows.map((row) => row.id);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing left to do
    }
  }
}

/**
 * Puts a snapshot in place of `state.db`. Preconditions the caller holds: the daemon is stopped (instance lock or a
 * stopped unit). The snapshot is verified first; the stale -wal and -shm of the database being replaced are removed BEFORE
 * the rename, because a leftover WAL replayed onto a different database corrupts it; the new file is flushed, then renamed.
 */
export function restoreDatabaseFile(snapshotPath: string, home: string, knownIds: ReadonlySet<string>): void {
  const ids = schemaIds(snapshotPath);
  if (ids === null) throw new SnapshotError("the snapshot is damaged: nothing was restored");
  if (ids.some((id) => !knownIds.has(id)))
    throw new SnapshotError("the snapshot was written by a newer pap: nothing was restored");
  const target = join(home, "state.db");
  const temp = `${target}.restore-${process.pid}`;
  try {
    rmSync(temp, { force: true });
    copyFileSync(snapshotPath, temp, 1 /* COPYFILE_EXCL */);
    chmodSync(temp, 0o600);
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    renameSync(temp, target);
    const dir = openSync(home, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw new SnapshotError(`restore failed: ${(error as { code?: string }).code ?? "error"}`);
  }
}
