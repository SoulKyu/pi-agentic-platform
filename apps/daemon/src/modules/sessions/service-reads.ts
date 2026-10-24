import {
  type ChildView,
  type Cursor,
  type Caller,
  EMPTY_QUEUE,
  type ForkPoint,
  type HistoryMeta,
  IDLE_ACTIVITY,
  PapError,
  type SessionPolicyView,
  type SessionStatus,
  type SessionSummary,
  type SessionStreamEvent,
  type TranscriptRow,
} from "@pap/contracts";
import { cutUnits, MAX_ID_CHARS } from "../../kernel/text.ts";
import { mirrorFileOf, unverifiedIds } from "../agent-vm/index.ts";
import { mirrorRowOf } from "./mirror-row.ts";
import { isPiSessionFile } from "./pi-files.ts";
import type { BranchPage, BranchPathEntry } from "./branch.ts";
import {
  fitPage,
  fitPoints,
  fitSnapshot,
  PAGE_BYTES,
  SNAPSHOT_ROWS,
  sizeOf,
  withTrimmedHistory,
} from "./snapshot.ts";
import type { SessionRow, SessionsStore } from "./store.ts";
import type { TranscriptReader } from "./transcript.ts";
import type { LiveSession } from "./live-session.ts";

const EMPTY_PAGE: BranchPage = {
  rows: [],
  hasMore: false,
  oldestEntryId: null,
  turnsBefore: 0,
  leafId: null,
};

/** A tool output's text once JSON-encoded, and its arguments. */
const OUTPUT_JSON_BYTES = 800_000;
const ARGS_BYTES = 64 * 1024;
const DEFAULT_PAGE_ROWS = 50;

/**
 * The longest prefix of `text` whose JSON encoding fits in `max` bytes (escapes can make a character six bytes). A
 * character is at least one byte, so no prefix longer than `max` characters can fit: the search starts there, and a
 * 64 MB tool result costs a few stringifies of at most `max` characters (M2-RT-29).
 */
export function clipJsonText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max && Buffer.byteLength(JSON.stringify(text)) <= max) return { text, truncated: false };
  let low = 0;
  let high = Math.min(text.length, max);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, mid))) <= max) low = mid;
    else high = mid - 1;
  }
  // Never end on half of a surrogate pair.
  return { text: cutUnits(text, low), truncated: true };
}

const textOfResult = (result: unknown): string => {
  const content = (result as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "",
    )
    .join("");
};

export interface SessionReadsDeps {
  readonly store: SessionsStore;
  readonly agentDir: string;
  /** A VM row's Pi file is its mirror under `<papHome>/agents/.mirrors/<agent id>/` (R23). */
  readonly papHome: string;
  /** Loads the reader of Pi's session files; the SDK behind it is heavy, so it is asked for when first needed. */
  loadTranscript(): Promise<TranscriptReader>;
  readonly live: ReadonlyMap<string, LiveSession>;
  statusOf(id: string): SessionStatus;
  owned(id: string, caller: Caller): SessionRow;
  /** The Pi file changed outside pap in the last 2 minutes (owner Q13). */
  outsideWrite(id: string): boolean;
  /** The session's mode, whether it chose it, and its taint, read from the policy module (M5R61). */
  policyView(row: SessionRow): SessionPolicyView;
  /** The session's subagents with their open dialogs (M11R140). */
  children(sessionId: string): ChildView[];
}

export interface SessionReads {
  /** The cursor the subscription may replay from: `after`, or none when the file changed outside pap. */
  prepare(sessionId: string, caller: Caller, after?: Cursor): Promise<Cursor | undefined>;
  snapshot(sessionId: string): SessionStreamEvent;
  /** The memoized load `prepare` awaits. */
  ensureReader(): Promise<TranscriptReader>;
  /** Rows older than `before` on the branch that ends at `before`, newest last. */
  history(
    input: { sessionId: string; before: string; limit?: number | undefined },
    caller: Caller,
  ): Promise<HistoryMeta & { rows: TranscriptRow[] }>;
  /** A tool call's whole result (bounded) and arguments, found on the session's active branch. */
  toolOutput(
    input: { sessionId: string; toolCallId: string; resultEntryId?: string | undefined },
    caller: Caller,
  ): Promise<{ text: string; truncated: boolean; isError: boolean; args: string | null }>;
  branches(
    sessionId: string,
    caller: Caller,
  ): Promise<{ leafId: string | null; points: ForkPoint[]; truncated: boolean }>;
  /** Every session of the caller, newest first, with its live status. */
  summaries(caller: Caller): SessionSummary[];
  /** The session's current branch, root first, at most 10 000 entries: the live leaf for a hot session, the file's for a cold one. */
  branchPath(
    caller: Caller,
    sessionId: string,
  ): Promise<{ leafId: string | null; entries: BranchPathEntry[] }>;
  /** The text of the session's last assistant message on its current branch, cut to `max` characters; null when none. */
  agentText(sessionId: string, max: number, since?: number): Promise<string | null>;
}

/** The newest rows looked at for the last assistant message: tool traffic can sit between it and the leaf. */
const AGENT_TEXT_ROWS = 40;

export function createSessionReads(deps: SessionReadsDeps): SessionReads {
  let transcript: TranscriptReader | null = null;
  let loadingTranscript: Promise<TranscriptReader> | null = null;

  // One load for everyone who asks while it runs; a failed one is forgotten, so the next caller tries again.
  const ensureReader = (): Promise<TranscriptReader> => {
    loadingTranscript ??= deps.loadTranscript().then(
      (reader) => (transcript = reader),
      (error: unknown) => {
        loadingTranscript = null;
        throw error;
      },
    );
    return loadingTranscript;
  };

  // The file a session is read from: the one it recorded, else the one its worker reported if it is a Pi session file or
  // the mirror of its own agent (a VM session, R23). A draft's file is read only if it is where Pi keeps session files.
  const fileOf = (row: SessionRow, session: LiveSession | undefined): string | null => {
    const reported = session?.piFile();
    const trusted =
      reported &&
      (isPiSessionFile(deps.agentDir, reported) ||
        mirrorFileOf(deps.papHome, mirrorRowOf(deps.store.marks, row, reported)) !== null);
    return row.piPath ?? (trusted ? reported : null);
  };
  // R32: the user entries of a mirror that pap did not send show as such.
  const withMarks = (row: SessionRow, file: string | null, page: BranchPage): BranchPage => {
    if (!file || mirrorFileOf(deps.papHome, mirrorRowOf(deps.store.marks, row, file)) === null) return page;
    const listed = unverifiedIds(file);
    if (!listed.all && listed.ids.size === 0) return page;
    // A list that cannot be trusted (unreadable, cut) marks every user row: fail closed (AVM-E22).
    const unsent = (r: TranscriptRow): boolean =>
      listed.all
        ? (r.message as { role?: unknown } | null)?.role === "user"
        : r.entryId !== null && listed.ids.has(r.entryId);
    const rows = page.rows.map((r) => (unsent(r) ? { ...r, unverified: true as const } : r));
    return { ...page, rows };
  };

  return {
    ensureReader,
    summaries: (caller) =>
      deps.store.listByOwner(caller.userId).map((row) => ({
        id: row.id,
        cwd: row.cwd,
        name: row.name,
        status: deps.statusOf(row.id),
        toolPreset: row.toolPreset ?? "configured",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    async history({ sessionId, before, limit }, caller) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const file = fileOf(row, deps.live.get(sessionId));
      if (!file) return { rows: [], hasMore: false, oldestEntryId: null, turnsBefore: 0 };
      // The whole file: rows older than the cursor were written before the run that may be going on (R38).
      const { rows, hasMore, oldestEntryId, turnsBefore } = fitPage(
        withMarks(row, file, reader.page(file, { before, limit: limit ?? DEFAULT_PAGE_ROWS })),
        PAGE_BYTES,
      );
      return { rows, hasMore, oldestEntryId, turnsBefore };
    },
    async toolOutput({ sessionId, toolCallId, resultEntryId }, caller) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const session = deps.live.get(sessionId);
      const file = fileOf(row, session);
      const found = file
        ? reader.toolCall(file, toolCallId, session?.leafId() ?? null, resultEntryId)
        : { result: null, args: null };
      if (found.result === null) throw new PapError("not_found");
      const { text, truncated } = clipJsonText(textOfResult(found.result), OUTPUT_JSON_BYTES);
      const args =
        found.args === null ? null : clipJsonText(JSON.stringify(found.args) ?? "", ARGS_BYTES).text;
      return { text, truncated, isError: (found.result as { isError?: unknown }).isError === true, args };
    },
    async branches(sessionId, caller) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const session = deps.live.get(sessionId);
      const file = fileOf(row, session);
      const known = session?.leafId() ?? (file ? reader.lastEntryId(file) : null);
      // An id over the contract's bound cannot be carried: the leaf is then unknown, as for the snapshot (M2R4).
      const leafId = known !== null && known.length <= MAX_ID_CHARS ? known : null;
      if (!file) return { leafId, points: [], truncated: false };
      // The list is measured in JSON bytes with its envelope, like a history page (M2R54).
      const envelope = sizeOf({ leafId, points: [], truncated: true });
      return { leafId, ...fitPoints(reader.forks(file, known), PAGE_BYTES - envelope) };
    },
    async branchPath(caller, sessionId) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const session = deps.live.get(sessionId);
      const file = fileOf(row, session);
      return file ? reader.branchPath(file, session?.leafId() ?? null) : { leafId: null, entries: [] };
    },
    async agentText(sessionId, max, since) {
      const row = deps.store.get(sessionId);
      if (!row) return null;
      const reader = await ensureReader();
      const session = deps.live.get(sessionId);
      const file = fileOf(row, session);
      if (!file) return null;
      const rows = reader.page(file, { leafId: session?.leafId() ?? null, limit: AGENT_TEXT_ROWS }).rows;
      for (const { message } of rows.toReversed()) {
        const { role } = message as { role?: unknown };
        if (role !== "assistant") continue;
        // A newest answer older than `since` belongs to an earlier run: it is not this task's (fail closed on no time).
        const at = (message as { timestamp?: unknown }).timestamp;
        if (since !== undefined && !(typeof at === "number" && at >= since)) return null;
        return cutUnits(textOfResult(message), max);
      }
      return null;
    },
    async prepare(sessionId, caller, after) {
      deps.owned(sessionId, caller);
      await ensureReader();
      // A write made outside pap publishes nothing on this stream: replaying from the client's cursor would show
      // neither the notice nor the new entries, so a fresh snapshot is sent instead (owner Q13).
      return deps.outsideWrite(sessionId) ? undefined : after;
    },
    snapshot(sessionId) {
      const row = deps.store.get(sessionId);
      if (!row) throw new PapError("not_found");
      if (!transcript) throw new PapError("internal");
      const session = deps.live.get(sessionId);
      const run = session?.runView() ?? null;
      const file = fileOf(row, session);
      // A run in progress is not in the file yet: the file is read as it was when the run began, along the branch
      // that ended at the leaf then (R38), and the run's own rows follow. Between runs the page follows the leaf the
      // worker reported; with none known (a cold session, an id the contract cannot carry) it follows the file's last
      // entry (M2R4).
      const page = file
        ? withMarks(
            row,
            file,
            transcript.page(file, {
              leafId: run ? run.leafAtStart : session?.leafId(),
              upToBytes: run?.baselineBytes,
              limit: SNAPSHOT_ROWS,
            }),
          )
        : EMPTY_PAGE;
      const rows: TranscriptRow[] = [...page.rows, ...(run?.rows ?? [])];
      // Only the three fields of the contract: the page's own rows are not part of it.
      const history = {
        hasMore: page.hasMore,
        oldestEntryId: page.oldestEntryId,
        turnsBefore: page.turnsBefore,
      };
      const snapshot = fitSnapshot({
        status: deps.statusOf(sessionId),
        rows,
        dialogs: session?.dialogs() ?? [],
        statuses: session?.statuses() ?? [],
        widgets: session?.widgets() ?? [],
        title: session?.title() ?? null,
        panels: session?.panels() ?? [],
        notices: session?.notices() ?? [],
        partial: session?.partial() ?? null,
        queue: session?.queue() ?? EMPTY_QUEUE,
        activity: session?.activity() ?? IDLE_ACTIVITY,
        history,
        leafId: session?.leafId() ?? page.leafId,
        name: row.name,
        cwd: row.cwd,
        outsideWrite: deps.outsideWrite(sessionId),
        policy: deps.policyView(row),
        loadout: session?.loadout() ?? null,
        toolPreset: row.toolPreset ?? "configured",
        children: deps.children(sessionId),
      });
      return withTrimmedHistory(snapshot, rows, history);
    },
  };
}
