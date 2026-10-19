import { sizeOf } from "../../kernel/json-bytes.ts";
import { MAX_ID_CHARS } from "../../kernel/text.ts";
import type { BranchPage } from "./branch.ts";
import {
  type Activity,
  type ChildView,
  DEFAULT_SESSION_POLICY_VIEW,
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
  type SessionLoadout,
  type ToolPreset,
  type SessionPolicyView,
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

const MAX_CALL_ID_CHARS = 256;

// A role or a call id goes into a placeholder only as plain text: escaped, a 64-character role weighs 384 bytes (RT-17).
const plain = (text: string, maxBytes: number): boolean => sizeOf(text) <= maxBytes + 2;

/** What stands for a row of `bytes` bytes that was too big to send (R109). */
export function placeholderRow(row: unknown, bytes: number) {
  const fields =
    typeof row === "object" && row !== null
      ? (row as { role?: unknown; timestamp?: unknown; toolCallId?: unknown })
      : {};
  const role = typeof fields.role === "string" ? fields.role.slice(0, MAX_ROLE_CHARS) : "";
  return {
    role: role !== "" && plain(role, MAX_ROLE_CHARS) ? role : "unknown",
    // A tool result keeps the call it answers, so the client can close that call and offer the whole output.
    ...(typeof fields.toolCallId === "string" &&
    fields.toolCallId.length <= MAX_CALL_ID_CHARS &&
    plain(fields.toolCallId, MAX_CALL_ID_CHARS)
      ? { toolCallId: fields.toolCallId }
      : {}),
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
/** The share of the budget the rows always keep, whatever the dialogs and decorations take (M2 final M4). */
export const ROW_FLOOR_SHARE = 16;
/** Dialogs other than approvals, together, past the oldest one: an extension's large dialogs cannot crowd out the transcript (M4R8). */
export const OTHER_DIALOG_BYTES = 256 * 1024;

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
  readonly cwd?: string;
  readonly outsideWrite?: boolean;
  readonly policy?: SessionPolicyView;
  readonly loadout?: SessionLoadout | null;
  readonly toolPreset?: ToolPreset;
  readonly children?: readonly ChildView[];
}

/** A row as it goes into a snapshot: its message bounded like `boundedRow`, its entry id kept. */
export function fitRow(row: TranscriptRow): { row: TranscriptRow; size: number } {
  const size = sizeOf(row);
  if (size <= ROW_BYTES) return { row, size };
  // `unverified` (R32) survives the bound: a forged user entry too big to show is still shown as forged.
  const bounded: TranscriptRow = { ...row, message: placeholderRow(row.message, size) };
  return { row: bounded, size: sizeOf(bounded) };
}

/**
 * The snapshot a subscriber gets when it cannot resume from a cursor, under `budget` JSON bytes (M2-RT-05). The fixed
 * sections (status, queue, title, history, activity, leaf, name) are always in. Then the open dialogs, approvals
 * first (the policy holds a tool call on them, M2R9), kept in their own order. Rows keep a floor of
 * `budget / ROW_FLOOR_SHARE` bytes: everything but approvals and rows is fitted under `room = budget - floor`. The
 * oldest dialog that is not an approval is offered the whole `room`; the other such dialogs go in only while together
 * within `OTHER_DIALOG_BYTES`. Then decorations under `DECORATION_BYTES` (statuses, the newest notices, widgets
 * oldest first; `decorationsTruncated` says when one was left out); then open panels (under `PANEL_BYTES` together),
 * the partial reply if it fits whole, and the rows, newest first and contiguous, each over `ROW_BYTES` as a
 * placeholder (R109). Up to the newest row that has an entry id, a row that does not fit goes in as a placeholder, so
 * the history cursor always points at a row the client has (M4R9).
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
    cwd: input.cwd ?? "",
    outsideWrite: input.outsideWrite ?? false,
    policy: input.policy ?? DEFAULT_SESSION_POLICY_VIEW,
    loadout: input.loadout ?? null,
    toolPreset: input.toolPreset ?? "configured",
    children: [],
    hiddenChildren: 0,
  };
  let used = sizeOf(snapshot);
  // Everything but approvals and rows stays under `room`: the rows keep their floor (M4R7).
  const room = budget - Math.floor(budget / ROW_FLOOR_SHARE);
  const kept = new Set<Dialog>();
  const approvalsFirst = [
    ...input.dialogs.filter((dialog) => dialog.method === "approval"),
    ...input.dialogs.filter((dialog) => dialog.method !== "approval"),
  ];
  let otherDialogs = 0;
  let oldestOther = true;
  for (const dialog of approvalsFirst) {
    const size = sizeOf(dialog) + 1;
    if (dialog.method === "approval") {
      if (used + size > budget) continue;
    } else {
      // The oldest one may take the whole room, so one large dialog stays answerable after a reload; the others
      // share OTHER_DIALOG_BYTES (M4R8).
      const oldest = oldestOther;
      oldestOther = false;
      if (used + size > room || (!oldest && otherDialogs + size > OTHER_DIALOG_BYTES)) continue;
      otherDialogs += size;
    }
    used += size;
    kept.add(dialog);
  }
  snapshot.dialogs = input.dialogs.filter((dialog) => kept.has(dialog));
  // A dialog left out is still open in the worker: the client is told how many, so it can say something is waiting.
  snapshot.hiddenDialogs = input.dialogs.length - snapshot.dialogs.length;
  // The children's dialogs come after the session's own approvals: they only take what is left of the room (review M8).
  // A child whose line alone does not fit is left out and counted, so the client knows it exists.
  for (const child of input.children ?? []) {
    const size = sizeOf(child) + 1;
    const fits = used + size <= room;
    const kept = fits
      ? child
      : { ...child, dialogs: [], hiddenDialogs: child.hiddenDialogs + child.dialogs.length };
    const taken = fits ? size : sizeOf(kept) + 1;
    if (used + taken > room) {
      snapshot.hiddenChildren += 1;
      continue;
    }
    used += taken;
    snapshot.children.push(kept);
  }
  let decorations = 0;
  // At most `limit` items whatever the source sent (`newest`: the last ones), then as many as the byte budget allows.
  const decorate = <T>(all: readonly T[], limit: number, newest = false): T[] => {
    const items = newest ? all.slice(-limit).toReversed() : all.slice(0, limit);
    if (all.length > limit) snapshot.decorationsTruncated = true;
    const taken: T[] = [];
    for (const item of items) {
      const size = sizeOf(item) + 1;
      if (decorations + size > DECORATION_BYTES || used + size > room) {
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
    if (panelBytes + size > PANEL_BYTES || used + size > room) {
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
    if (size <= PARTIAL_BYTES && used + size <= room) {
      used += size;
      snapshot.partial = partial;
    }
  }
  const offered = input.rows.slice(-SNAPSHOT_ROWS).toReversed();
  // Rows newer than the newest bound one, and that row itself, go in as placeholders when they do not fit, so the
  // client always has a row its next page can start above (M4R9). Past it, the first row that does not fit ends them.
  const reach = offered.findIndex((row) => row.entryId !== null);
  const newestFirst: TranscriptRow[] = [];
  for (const [index, candidate] of offered.entries()) {
    const { row, size } = fitRow(candidate);
    if (used + size + 1 <= budget) {
      used += size + 1;
      newestFirst.push(row);
      continue;
    }
    if (index > reach) break;
    const stand: TranscriptRow = {
      entryId: candidate.entryId,
      message: placeholderRow(candidate.message, sizeOf(candidate)),
      // The mark of a forged user entry stays on its placeholder (R32).
      ...(candidate.unverified === true ? { unverified: true as const } : {}),
    };
    const standSize = sizeOf(stand) + 1;
    if (used + standSize > budget) break;
    used += standSize;
    newestFirst.push(stand);
  }
  snapshot.rows = newestFirst.toReversed();
  return snapshot;
}

const ANCHOR_ROLES: ReadonlySet<string> = new Set(["user", "compactionSummary", "branchSummary", "custom"]);
const isAnchorRow = (row: TranscriptRow): boolean =>
  ANCHOR_ROLES.has(String((row.message as { role?: unknown } | null)?.role));

/**
 * When the snapshot had to leave out older rows (the 75-row cap or the byte budget), the client's next page must start
 * just above the oldest row it got, and the turns above count what was left out. The `find` always meets a bound row
 * when the offered rows hold one: `fitSnapshot` keeps the newest bound row, as a placeholder if it must.
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
