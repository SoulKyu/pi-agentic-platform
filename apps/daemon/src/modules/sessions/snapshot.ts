import {
  type Activity,
  type Dialog,
  EMPTY_QUEUE,
  type HistoryMeta,
  IDLE_ACTIVITY,
  NO_HISTORY,
  type Notice,
  type Panel,
  type PartialMessage,
  type QueueView,
  type SessionStatus,
  type SnapshotEvent,
  type StatusEntry,
  type TranscriptRow,
  type Widget,
} from "@pap/contracts";

/** About the last 75 rows of a transcript (spec C 4.3). */
export const SNAPSHOT_ROWS = 75;
/** One snapshot event as sent: the socket allows 1 MiB per frame, and the frame's own fields need a few hundred bytes. */
export const SNAPSHOT_BYTES = 1_000_000;

/** The most one row may weigh in a snapshot. A bigger one is replaced by a placeholder, so it can never empty the snapshot. */
export const ROW_BYTES = 256 * 1024;

export const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null");

/** A role is one word; a row whose role is not is not worth more than this in a placeholder. */
const MAX_ROLE_CHARS = 64;

/** What stands for a row of `bytes` bytes that was too big to send (R109). */
export function placeholderRow(row: unknown, bytes: number) {
  const fields =
    typeof row === "object" && row !== null ? (row as { role?: unknown; timestamp?: unknown }) : {};
  return {
    role: typeof fields.role === "string" ? fields.role.slice(0, MAX_ROLE_CHARS) : "unknown",
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

/** The partial reply goes in only up to this size; a client then gets the whole reply from `message_end`. */
export const PARTIAL_BYTES = 256 * 1024;
/** Statuses, notices and widgets together, in JSON bytes: extension text cannot crowd out what a run waits on. */
export const DECORATION_BYTES = 256 * 1024;

export interface SnapshotInput {
  readonly status: SessionStatus;
  readonly rows: readonly TranscriptRow[];
  readonly dialogs: readonly Dialog[];
  readonly partial?: PartialMessage | null;
  readonly queue?: QueueView;
  readonly statuses?: readonly StatusEntry[];
  readonly widgets?: readonly Widget[];
  readonly title?: string | null;
  readonly panels?: readonly Panel[];
  readonly notices?: readonly Notice[];
  readonly history?: HistoryMeta;
  readonly activity?: Activity;
  readonly leafId?: string | null;
  readonly name?: string | null;
}

/** A row as it goes into a snapshot: its message bounded like `boundedRow`, its entry id kept. */
export function fitRow(row: TranscriptRow): { row: TranscriptRow; size: number } {
  const size = sizeOf(row);
  if (size <= ROW_BYTES) return { row, size };
  const bounded = { entryId: row.entryId, message: placeholderRow(row.message, size) };
  return { row: bounded, size: sizeOf(bounded) };
}

/**
 * The snapshot a subscriber gets when it cannot resume from a cursor, under `budget` JSON bytes (M2-RT-05). The fixed
 * sections (status, queue, title, history, activity, leaf, name) are always in. Then the open dialogs, approvals
 * first (the policy holds a tool call on them), kept in their own order; then decorations under `DECORATION_BYTES`
 * (statuses, the newest notices, widgets oldest first; `decorationsTruncated` says when one was left out); then open
 * panels, the partial reply if it fits whole, and the rows, newest first and contiguous, each over `ROW_BYTES` as a
 * placeholder (R109).
 */
export function fitSnapshot(input: SnapshotInput, budget = SNAPSHOT_BYTES): SnapshotEvent {
  const snapshot: SnapshotEvent = {
    kind: "snapshot",
    status: input.status,
    rows: [],
    dialogs: [],
    partial: null,
    queue: input.queue ?? EMPTY_QUEUE,
    statuses: [],
    widgets: [],
    title: input.title ?? null,
    panels: [],
    notices: [],
    decorationsTruncated: false,
    history: input.history ?? NO_HISTORY,
    activity: input.activity ?? IDLE_ACTIVITY,
    leafId: input.leafId ?? null,
    name: input.name ?? null,
  };
  let used = sizeOf(snapshot);
  const kept = new Set<Dialog>();
  const approvalsFirst = [
    ...input.dialogs.filter((dialog) => dialog.method === "approval"),
    ...input.dialogs.filter((dialog) => dialog.method !== "approval"),
  ];
  for (const dialog of approvalsFirst) {
    const size = sizeOf(dialog) + 1;
    if (used + size > budget) continue;
    used += size;
    kept.add(dialog);
  }
  snapshot.dialogs = input.dialogs.filter((dialog) => kept.has(dialog));
  let decorations = 0;
  const decorate = <T>(items: readonly T[]): T[] => {
    const taken: T[] = [];
    for (const item of items) {
      const size = sizeOf(item) + 1;
      if (decorations + size > DECORATION_BYTES || used + size > budget) {
        snapshot.decorationsTruncated = true;
        break;
      }
      decorations += size;
      used += size;
      taken.push(item);
    }
    return taken;
  };
  snapshot.statuses = decorate(input.statuses ?? []);
  snapshot.notices = decorate((input.notices ?? []).toReversed()).toReversed();
  snapshot.widgets = decorate(input.widgets ?? []);
  for (const panel of input.panels ?? []) {
    const size = sizeOf(panel) + 1;
    if (used + size > budget) continue;
    used += size;
    snapshot.panels.push(panel);
  }
  const partial = input.partial ?? null;
  if (partial) {
    const size = sizeOf(partial);
    if (size <= PARTIAL_BYTES && used + size <= budget) {
      used += size;
      snapshot.partial = partial;
    }
  }
  const newestFirst: TranscriptRow[] = [];
  for (const candidate of input.rows.slice(-SNAPSHOT_ROWS).toReversed()) {
    const { row, size } = fitRow(candidate);
    if (used + size + 1 > budget) break;
    used += size + 1;
    newestFirst.push(row);
  }
  snapshot.rows = newestFirst.toReversed();
  return snapshot;
}
