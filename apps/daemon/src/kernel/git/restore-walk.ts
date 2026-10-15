import { lstat, readdir } from "node:fs/promises";

/** A folder a restore would replace by a file is walked up to this many entries; more counts as a conflict. */
export const WALK_MAX_ENTRIES = 10_000;
/** At most this many foreign entries are named to the caller. */
export const WALK_MAX_LISTED = 50;

export interface FolderVerdict {
  /** True when the folder holds an entry that `held` does not name, or has more than `limit` entries. */
  readonly conflict: boolean;
  /** The entries the capture did not hold (latin1 paths relative to the lane), up to `WALK_MAX_LISTED`. */
  readonly foreign: string[];
}

/**
 * Walks the folder `rel` (a latin1 path), never following a symlink, and checks every file and link against `held`,
 * the paths the undo capture held. Empty folders hold nothing and do not count against it.
 */
export async function walkFolder(
  root: string,
  rel: string,
  held: ReadonlySet<string>,
  limit: number = WALK_MAX_ENTRIES,
): Promise<FolderVerdict> {
  const foreign: string[] = [];
  let conflict = false;
  let seen = 0;
  const pending = [rel];
  while (pending.length > 0) {
    const folder = pending.pop() as string;
    const names = await readdir(Buffer.concat([Buffer.from(`${root}/`), Buffer.from(folder, "latin1")]), {
      encoding: "buffer",
    }).catch(() => null);
    if (names === null) return { conflict: true, foreign };
    for (const name of names) {
      seen += 1;
      if (seen > limit) return { conflict: true, foreign };
      const path = `${folder}/${name.toString("latin1")}`;
      const info = await lstat(Buffer.concat([Buffer.from(`${root}/`), Buffer.from(path, "latin1")])).catch(
        () => null,
      );
      if (info?.isDirectory()) pending.push(path);
      else if (!held.has(path)) {
        conflict = true;
        if (foreign.length < WALK_MAX_LISTED) foreign.push(path);
      }
    }
  }
  return { conflict, foreign };
}
