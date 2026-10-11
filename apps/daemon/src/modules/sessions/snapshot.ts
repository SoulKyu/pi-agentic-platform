import type { Dialog, SessionStatus, SessionStreamEvent } from "@pap/contracts";

/** About the last 75 rows of a transcript (spec C 4.3). */
export const SNAPSHOT_ROWS = 75;
/** One snapshot event as sent: the socket allows 1 MiB per frame, and the frame's own fields need a few hundred bytes. */
export const SNAPSHOT_BYTES = 1_000_000;

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null");

export interface SnapshotInput {
  readonly status: SessionStatus;
  readonly rows: readonly unknown[];
  readonly dialogs: readonly Dialog[];
}

/**
 * The snapshot a subscriber gets when it cannot resume from a cursor, held under `budget` bytes (R79). Open dialogs
 * come first, oldest first, because a run may be waiting for the user's answer to one; a dialog that does not fit is
 * left out. The rows that remain go newest first and stay contiguous: the history ends at the first row that does
 * not fit, never skips over it.
 */
export function fitSnapshot(input: SnapshotInput, budget = SNAPSHOT_BYTES): SessionStreamEvent {
  let used = sizeOf({ kind: "snapshot", status: input.status, messages: [], dialogs: [] });
  const dialogs: Dialog[] = [];
  for (const dialog of input.dialogs) {
    const size = sizeOf(dialog) + 1;
    if (used + size > budget) continue;
    used += size;
    dialogs.push(dialog);
  }
  const candidates = input.rows.slice(-SNAPSHOT_ROWS);
  const newestFirst: unknown[] = [];
  for (const row of candidates.toReversed()) {
    const size = sizeOf(row) + 1;
    if (used + size > budget) break;
    used += size;
    newestFirst.push(row);
  }
  return { kind: "snapshot", status: input.status, messages: newestFirst.toReversed(), dialogs };
}
