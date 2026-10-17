import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readPending } from "./pending.ts";

export const KEEP_SNAPSHOTS = 3;
/** Same shape as `PendingSchema.snapshot`: only files pap itself names this way are ever removed. */
const SNAPSHOT_NAME = /^pre-update-[A-Za-z0-9._-]{1,120}\.db$/;

export interface PruneResult {
  /** False when `backups/` could not be listed (nothing was tried). */
  readonly ran: boolean;
  readonly removed: string[];
  /** Snapshots that should have gone and could not be removed. */
  readonly failed: string[];
}

/**
 * M6bR19, M6b-C3: after a successful update only the newest `keep` snapshots `pre-update-*.db` stay (by modification time).
 * Never removed: the snapshot `thisRun` names, and the one a live `pending.json` names. A damaged `pending.json` may name
 * any of them, so then nothing is removed. A file that cannot be removed stays and is reported in `failed`; a file that
 * vanishes between the listing and `lstat` is skipped. `beforeStat` is a test seam for that race.
 */
export function pruneSnapshots(
  home: string,
  thisRun: string | null = null,
  keep = KEEP_SNAPSHOTS,
  beforeStat: (path: string) => void = () => undefined,
): PruneResult {
  const pending = readPending(home);
  if (pending === "damaged") return { ran: true, removed: [], failed: [] };
  const protectedNames = new Set([thisRun, pending?.snapshot ?? null]);
  const dir = join(home, "backups");
  const entries: { name: string; mtimeMs: number }[] = [];
  const failed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => SNAPSHOT_NAME.test(name));
  } catch (error) {
    // no backups folder yet is nothing to prune; anything else is a failure to look
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ran: true, removed: [], failed: [] }
      : { ran: false, removed: [], failed: [] };
  }
  for (const name of names) {
    try {
      beforeStat(join(dir, name));
      const info = lstatSync(join(dir, name));
      if (info.isFile()) entries.push({ name, mtimeMs: info.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed.push(name); // gone is fine; unreadable is not
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
  const removed: string[] = [];
  for (const { name } of entries.slice(keep)) {
    if (protectedNames.has(name)) continue;
    try {
      rmSync(join(dir, name));
      removed.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { ran: true, removed, failed };
}
