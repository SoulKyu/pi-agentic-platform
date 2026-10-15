/** One entry of the session's branch, root to leaf. */
export interface PathEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly user: boolean;
  readonly preview: string;
}

export interface TurnRange {
  readonly index: number;
  readonly userEntryId: string;
  readonly preview: string;
  /** The checkpoint key before the turn: an entry id, `root`, or null when nothing was captured before it. */
  readonly from: string | null;
  /** The checkpoint key at its end, or `live` when the turn has none of its own (the worktree is its end). */
  readonly to: string;
}

export interface CheckpointTarget {
  /** The entry the checkpoint belongs to, or null for the `root` checkpoint. */
  readonly entryId: string | null;
  /** The turn that entry falls in, or null before the first user message. */
  readonly turn: number | null;
  /** True when the target is the leaf itself. */
  readonly exact: boolean;
}

/** A longer branch is cut at this many entries, the oldest first (M9R57). */
export const MAX_TURN_PATH = 10_000;

const ROOT = "root";

/** The branch the functions read: the newest `MAX_TURN_PATH` entries, and whether older ones were cut. */
function window(path: readonly PathEntry[]): { entries: readonly PathEntry[]; cut: boolean } {
  return path.length > MAX_TURN_PATH
    ? { entries: path.slice(path.length - MAX_TURN_PATH), cut: true }
    : { entries: path, cut: false };
}

/**
 * The turns of a session's branch (pure). A turn starts at a user message U. It starts from the nearest strict
 * ancestor of U that has a checkpoint (`root` when the branch has none and `root` has one). It ends at the nearest
 * checkpoint at or before the entry preceding the next user message, when that entry is a descendant of U, else `live`.
 * `refs` holds the entry ids that have a checkpoint ref, and `root`.
 */
export function turnRanges(path: readonly PathEntry[], refs: ReadonlySet<string>): TurnRange[] {
  const { entries, cut } = window(path);
  const starts = entries.flatMap((entry, at) => (entry.user ? [at] : []));
  const nearest = (from: number, floor: number): number => {
    for (let at = from; at > floor; at -= 1) if (refs.has(entries[at]?.id ?? "")) return at;
    return -1;
  };
  return starts.map((start, n) => {
    const user = entries[start] as PathEntry;
    const before = nearest(start - 1, -1);
    const end = (starts[n + 1] ?? entries.length) - 1;
    const inside = nearest(end, start);
    return {
      index: n + 1,
      userEntryId: user.id,
      preview: user.preview,
      from: before >= 0 ? (entries[before] as PathEntry).id : !cut && refs.has(ROOT) ? ROOT : null,
      to: inside >= 0 ? (entries[inside] as PathEntry).id : "live",
    };
  });
}

/** The checkpoint to restore for the branch's leaf: the nearest ancestor-or-self that has one (pure). */
export function checkpointTarget(
  path: readonly PathEntry[],
  refs: ReadonlySet<string>,
): CheckpointTarget | null {
  const { entries, cut } = window(path);
  let turn = entries.filter((entry) => entry.user).length;
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at] as PathEntry;
    if (refs.has(entry.id))
      return { entryId: entry.id, turn: turn === 0 ? null : turn, exact: at === entries.length - 1 };
    if (entry.user) turn -= 1;
  }
  return !cut && refs.has(ROOT) ? { entryId: null, turn: null, exact: entries.length === 0 } : null;
}
