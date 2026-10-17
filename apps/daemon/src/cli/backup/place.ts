import { lstatSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { snapshotDatabase } from "../ops/snapshot.ts";

/** What a restore may put into `$PAP_HOME`, in this order. `secrets` only when the manifest says it holds them. */
export const HOME_TOPS = ["attachments", "agents", "exports", "secrets"] as const;

export class PlaceError extends Error {
  override name = "PlaceError";
}

const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * Moves the verified tree in `extracted` into `home`. Everything it replaces is kept under `backups/pre-restore-<stamp>`:
 * the old database as a VACUUM INTO snapshot (`.db`), and by rename the old folders, `state.db` with its `-wal` and `-shm`
 * and the `search.db*` cache. Nothing is deleted, so a failure at any step moves every file back, newest first. Every
 * rename must stay on one file system: `extracted` and `backups/` are checked against `home` before anything moves.
 * `rename` is a parameter for tests only.
 */
export function placeRestored(
  home: string,
  extracted: string,
  stamp: string,
  tops: readonly string[],
  rename: typeof renameSync = renameSync,
): { keptDatabase: string | null; keptFolders: string | null } {
  // Everything that can be refused is refused before anything moves.
  try {
    if (!lstatSync(join(extracted, "state.db")).isFile()) throw new Error("not a file");
  } catch {
    throw new PlaceError("the backup holds no database");
  }
  for (const name of tops)
    if (!(HOME_TOPS as readonly string[]).includes(name))
      throw new PlaceError("unexpected folder in the backup");
  const device = statSync(home).dev;
  const backups = join(home, "backups");
  if (statSync(extracted).dev !== device || (present(backups) && statSync(backups).dev !== device))
    throw new PlaceError(
      "the data folder, its backups folder and the restore stage must be on one file system (a restore moves files by rename)",
    );

  const undo: Array<() => void> = [];
  const keep = join(backups, `pre-restore-${stamp}`);
  let keptFolders = false;
  let keptDatabase: string | null = null;
  const aside = (name: string): string => {
    if (!keptFolders) {
      mkdirSync(keep, { recursive: true, mode: 0o700 });
      keptFolders = true;
    }
    return join(keep, name);
  };
  const move = (from: string, to: string): void => {
    rename(from, to);
    undo.push(() => rename(to, from));
  };
  try {
    const db = join(home, "state.db");
    if (present(db)) {
      keptDatabase = join(backups, `pre-restore-${stamp}.db`);
      snapshotDatabase(db, keptDatabase, { held: true });
    }
    for (const name of tops) {
      const from = join(extracted, name);
      if (!present(from)) continue;
      const to = join(home, name);
      if (present(to)) move(to, aside(name));
      move(from, to);
    }
    // The database after the folders: its old file and its log go aside first, a leftover log must never meet the new file.
    for (const name of ["state.db-wal", "state.db-shm", "state.db"])
      if (present(join(home, name))) move(join(home, name), aside(name));
    move(join(extracted, "state.db"), db);
    // A cache, rebuilt at boot: moved aside like the rest, so a failure here is undone with everything else.
    for (const name of ["search.db", "search.db-wal", "search.db-shm"])
      if (present(join(home, name))) move(join(home, name), aside(name));
  } catch (error) {
    let failed = 0;
    for (const step of undo.reverse()) {
      try {
        step();
      } catch {
        failed++; // the remaining steps still run
      }
    }
    const code = (error as { code?: string }).code ?? "error";
    throw new PlaceError(
      failed === 0
        ? `restore failed while placing files (${code}); the data folder was put back as it was`
        : `restore failed while placing files (${code}); ${failed} move(s) could not be undone: your previous data is under ${keep}, and part of the restored files may already be in place`,
    );
  }
  return { keptDatabase, keptFolders: keptFolders ? keep : null };
}
