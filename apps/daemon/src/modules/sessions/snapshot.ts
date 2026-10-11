import { sizeOf } from "../../kernel/json-bytes.ts";
import type { BranchPage } from "./branch.ts";
import {
  type Activity,
  type Dialog,
  type ForkPoint,
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
  UI_LIMITS,
  type Widget,
} from "@pap/contracts";

export { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";

/** About the last 75 rows of a transcript (spec C 4.3). */
export const SNAPSHOT_ROWS = 75;
/** One snapshot event as sent: the socket allows 1 MiB per frame, and the frame's own fields need a few hundred bytes. */
export const SNAPSHOT_BYTES = 1_000_000;

/** The most one row may weigh in a snapshot. A bigger one is replaced by a placeholder, so it can never empty the snapshot. */
export const ROW_BYTES = 256 * 1024;

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
/** Open panels together, in JSON bytes: a panel of 200 long lines cannot starve the partial reply and the rows. */
export const PANEL_BYTES = 256 * 1024;

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
 * panels (under `PANEL_BYTES` together), the partial reply if it fits whole, and the rows, newest first and contiguous, each over `ROW_BYTES` as a
 * placeholder (R109).
 */
export function fitSnapshot(input: SnapshotInput, budget = SNAPSHOT_BYTES): SnapshotEvent {
  const snapshot: SnapshotEvent = {
    kind: "snapshot",
    status: input.status,
    rows: [],
    dialogs: [],
    hiddenDialogs: 0,
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
  // A dialog left out is still open in the worker: the client is told how many, so it can say something is waiting.
  snapshot.hiddenDialogs = input.dialogs.length - snapshot.dialogs.length;
  let decorations = 0;
  // At most `limit` items whatever the source sent (`newest`: the last ones), then as many as the byte budget allows.
  const decorate = <T>(all: readonly T[], limit: number, newest = false): T[] => {
    const items = newest ? all.slice(-limit).toReversed() : all.slice(0, limit);
    if (all.length > limit) snapshot.decorationsTruncated = true;
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
  snapshot.statuses = decorate(input.statuses ?? [], UI_LIMITS.statuses);
  snapshot.notices = decorate(input.notices ?? [], UI_LIMITS.notices, true).toReversed();
  snapshot.widgets = decorate(input.widgets ?? [], UI_LIMITS.widgets);
  const panels = input.panels ?? [];
  if (panels.length > UI_LIMITS.panels) snapshot.decorationsTruncated = true;
  let panelBytes = 0;
  for (const panel of panels.slice(0, UI_LIMITS.panels)) {
    const size = sizeOf(panel) + 1;
    if (panelBytes + size > PANEL_BYTES || used + size > budget) {
      snapshot.decorationsTruncated = true;
      continue;
    }
    panelBytes += size;
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

const ANCHOR_ROLES: ReadonlySet<string> = new Set(["user", "compactionSummary", "branchSummary", "custom"]);
const isAnchorRow = (row: TranscriptRow): boolean =>
  ANCHOR_ROLES.has(String((row.message as { role?: unknown } | null)?.role));

/**
 * When the snapshot had to leave out older rows (the 75-row cap or the byte budget), the client's next page must start
 * just above the oldest row it got, and the turns above count what was left out.
 */
export function withTrimmedHistory(
  snapshot: SnapshotEvent,
  offered: readonly TranscriptRow[],
  page: HistoryMeta,
): SnapshotEvent {
  const dropped = offered.length - snapshot.rows.length;
  if (dropped <= 0) {
    return {
      ...snapshot,
      history: { hasMore: page.hasMore, oldestEntryId: page.oldestEntryId, turnsBefore: page.turnsBefore },
    };
  }
  const anchors = offered.slice(0, dropped).filter(isAnchorRow).length;
  const oldest = snapshot.rows.find((row) => row.entryId !== null)?.entryId ?? page.oldestEntryId;
  return {
    ...snapshot,
    history: { hasMore: true, oldestEntryId: oldest, turnsBefore: page.turnsBefore + anchors },
  };
}

/**
 * A page under `budget` JSON bytes: each row over `ROW_BYTES` is a placeholder, then the oldest rows go first. The
 * cursor follows the oldest row kept, and the turns of the rows left out are counted into `turnsBefore`.
 */
export function fitPage(page: BranchPage, budget: number): BranchPage {
  const kept: TranscriptRow[] = [];
  let used = 0;
  for (const candidate of page.rows.toReversed()) {
    const { row, size } = fitRow(candidate);
    if (used + size + 1 > budget) break;
    used += size + 1;
    kept.unshift(row);
  }
  const dropped = page.rows.length - kept.length;
  if (dropped === 0) return kept.every((row, i) => row === page.rows[i]) ? page : { ...page, rows: kept };
  return {
    ...page,
    rows: kept,
    hasMore: true,
    oldestEntryId: kept[0]?.entryId ?? page.oldestEntryId,
    turnsBefore: page.turnsBefore + page.rows.slice(0, dropped).filter(isAnchorRow).length,
  };
}

/** The longest id the contract carries; an id is a key, so one over it cannot be clipped. */
export const MAX_ID_CHARS = 128;

/**
 * Fork points under `budget` JSON bytes. A choice whose entry id or target is over `MAX_ID_CHARS` is skipped (and a
 * point left with none), so the result always passes its schema; then the oldest points go first. `truncated` says
 * when anything was left out.
 */
export function fitPoints(
  points: readonly ForkPoint[],
  budget: number,
): { points: ForkPoint[]; truncated: boolean } {
  let truncated = false;
  const carried = points.flatMap((point) => {
    const choices = point.choices.filter(
      (choice) => choice.entryId.length <= MAX_ID_CHARS && choice.target.length <= MAX_ID_CHARS,
    );
    if (choices.length < point.choices.length) truncated = true;
    if (choices.length === 0 || (point.parentId?.length ?? 0) > MAX_ID_CHARS) {
      truncated = true;
      return [];
    }
    return [choices.length === point.choices.length ? point : { ...point, choices }];
  });
  const newestFirst: ForkPoint[] = [];
  let used = 0;
  for (const point of carried.toReversed()) {
    const size = sizeOf(point) + 1;
    if (used + size > budget) {
      truncated = true;
      break;
    }
    used += size;
    newestFirst.push(point);
  }
  return { points: newestFirst.toReversed(), truncated };
}
