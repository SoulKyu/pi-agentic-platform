import { PapError } from "@pap/contracts";

/** The seam type of every disk floor in M9 and M10: it returns nothing, so a `{ ok }` checker is a compile error (final review M14). */
export type DiskFloor = (path: string) => undefined;

/**
 * What a read that writes blobs into the owner's repository (`snapshotTree`: review, compare, checkpoint status, commit
 * message suggestion) checks first: a read-only daemon writes nothing, and a full disk is refused as `lanes.create` is
 * (final review M5). The floor's own `disk_low` passes through (M10's guard, R1); a failure of any other kind is `capacity`.
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
