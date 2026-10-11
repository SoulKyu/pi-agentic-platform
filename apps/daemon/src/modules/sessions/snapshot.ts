import type { Dialog, SessionStatus, SessionStreamEvent } from "@pap/contracts";

/** About the last 75 rows of a transcript (spec C 4.3). */
export const SNAPSHOT_ROWS = 75;
/** One snapshot event as sent: the socket allows 1 MiB per frame, and the frame's own fields need a few hundred bytes. */
export const SNAPSHOT_BYTES = 1_000_000;

/** The most one row may weigh in a snapshot. A bigger one is replaced by a placeholder, so it can never empty the snapshot. */
export const ROW_BYTES = 256 * 1024;

export const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null");

/** What stands for a row of `bytes` bytes that was too big to send (R109). */
export function placeholderRow(row: unknown, bytes: number) {
  const fields =
    typeof row === "object" && row !== null ? (row as { role?: unknown; timestamp?: unknown }) : {};
  return {
    role: typeof fields.role === "string" ? fields.role : "unknown",
    timestamp: typeof fields.timestamp === "number" ? fields.timestamp : null,
    omitted: true as const,
    bytes,
  };
}

/** The row as it goes into a snapshot, and how much room it takes. */
export function boundedRow(row: unknown): { row: unknown; size: number } {
  const size = sizeOf(row);
  if (size <= ROW_BYTES) return { row, size };
  const placeholder = placeholderRow(row, size);
  return { row: placeholder, size: sizeOf(placeholder) };
}

export interface SnapshotInput {
  readonly status: SessionStatus;
  readonly rows: readonly unknown[];
  readonly dialogs: readonly Dialog[];
}

/**
 * The snapshot a subscriber gets when it cannot resume from a cursor, held under `budget` bytes (R79). Open dialogs
 * come first, oldest first, because a run may be waiting for the user's answer to one; a dialog that does not fit is
 * left out. The rows that remain go newest first and stay contiguous: the history ends at the first row that does
 * not fit, never skips over it. A row over `ROW_BYTES` goes in as a placeholder, so one huge row never empties it.
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
  for (const candidate of candidates.toReversed()) {
    const { row, size } = boundedRow(candidate);
    if (used + size + 1 > budget) break;
    used += size + 1;
    newestFirst.push(row);
  }
  return { kind: "snapshot", status: input.status, messages: newestFirst.toReversed(), dialogs };
}
