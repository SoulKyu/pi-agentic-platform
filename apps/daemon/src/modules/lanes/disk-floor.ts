import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { PapError } from "@pap/contracts";

/** Under this much free space for an unprivileged user, a lane step is refused (M9R117). */
export const DISK_FLOOR_BYTES = 1024 ** 3;

type Statfs = (path: string) => { readonly bavail: number; readonly bsize: number };

/**
 * `LanesDeps.diskFloor` until M10 replaces it: `capacity` when the filesystem of `path` has less than 1 GiB free. A
 * folder that does not exist yet is measured at its nearest parent; a `statfs` that cannot be read refuses nothing
 * (M10's `freeMb` answers null on failure). The check is synchronous: it is made before the answer of `lanes.create`.
 */
export function localDiskFloor(path: string, statfs: Statfs = statfsSync): undefined {
  let at = path;
  for (;;) {
    try {
      const stats = statfs(at);
      if (stats.bavail * stats.bsize < DISK_FLOOR_BYTES) throw new PapError("capacity");
      return undefined;
    } catch (error) {
      if (error instanceof PapError) throw error;
      const parent = dirname(at);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === at) return undefined;
      at = parent;
    }
  }
}

/** The seam type of every disk floor in M9 and M10: it returns nothing, so a `{ ok }` checker is a compile error (final review M14). */
export type DiskFloor = (path: string) => undefined;

/**
 * What a read that writes blobs into the owner's repository (`snapshotTree`: review, compare, checkpoint status, commit
 * message suggestion) checks first: a read-only daemon writes nothing, and a full disk is refused as `lanes.create` is
 * (final review M5). A floor that fails any other way is `capacity`.
 */
export function guardSnapshot(
  deps: { readonly readOnly: boolean; diskFloor: DiskFloor },
  worktree: string,
): void {
  if (deps.readOnly) throw new PapError("read_only");
  try {
    deps.diskFloor(worktree);
  } catch (error) {
    throw error instanceof PapError ? error : new PapError("capacity");
  }
}
