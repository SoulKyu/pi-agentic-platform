import {
  type Caller,
  type ForkPoint,
  type HistoryMeta,
  PapError,
  type SessionStatus,
  type SessionStreamEvent,
  type TranscriptRow,
} from "@pap/contracts";
import { isPiSessionFile } from "./pi-files.ts";
import type { BranchPage } from "./branch.ts";
import {
  fitPage,
  fitPoints,
  fitSnapshot,
  MAX_ID_CHARS,
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

/** A history page, in JSON bytes: well under the 1 MiB frame, which also holds the page's other fields (M2R54). */
const PAGE_BYTES = 900_000;
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
  const end = low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1] ?? "") ? low - 1 : low;
  return { text: text.slice(0, end), truncated: true };
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
  /** Loads the reader of Pi's session files; the SDK behind it is heavy, so it is asked for when first needed. */
  loadTranscript(): Promise<TranscriptReader>;
  readonly live: ReadonlyMap<string, LiveSession>;
  statusOf(id: string): SessionStatus;
  owned(id: string, caller: Caller): SessionRow;
}

export interface SessionReads {
  prepare(sessionId: string, caller: Caller): Promise<void>;
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
    input: { sessionId: string; toolCallId: string },
    caller: Caller,
  ): Promise<{ text: string; truncated: boolean; isError: boolean; args: string | null }>;
  branches(
    sessionId: string,
    caller: Caller,
  ): Promise<{ leafId: string | null; points: ForkPoint[]; truncated: boolean }>;
}

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

  // The file a session is read from: the one it recorded, else the one its worker reported if it is a Pi session file.
  // A draft's file is read only if it is where Pi keeps session files.
  const fileOf = (row: SessionRow, session: LiveSession | undefined): string | null => {
    const reported = session?.piFile();
    return row.piPath ?? (reported && isPiSessionFile(deps.agentDir, reported) ? reported : null);
  };

  return {
    ensureReader,
    async history({ sessionId, before, limit }, caller) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const file = fileOf(row, deps.live.get(sessionId));
      if (!file) return { rows: [], hasMore: false, oldestEntryId: null, turnsBefore: 0 };
      // The whole file: rows older than the cursor were written before the run that may be going on (R38).
      const { rows, hasMore, oldestEntryId, turnsBefore } = fitPage(
        reader.page(file, { before, limit: limit ?? DEFAULT_PAGE_ROWS }),
        PAGE_BYTES,
      );
      return { rows, hasMore, oldestEntryId, turnsBefore };
    },
    async toolOutput({ sessionId, toolCallId }, caller) {
      const row = deps.owned(sessionId, caller);
      const reader = await ensureReader();
      const session = deps.live.get(sessionId);
      const file = fileOf(row, session);
      const found = file
        ? reader.toolCall(file, toolCallId, session?.leafId() ?? null)
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
    async prepare(sessionId, caller) {
      deps.owned(sessionId, caller);
      await ensureReader();
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
        ? transcript.page(file, {
            leafId: run ? run.leafAtStart : session?.leafId(),
            upToBytes: run?.baselineBytes,
            limit: SNAPSHOT_ROWS,
          })
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
        partial: session?.partial() ?? null,
        history,
        leafId: session?.leafId() ?? page.leafId,
      });
      return withTrimmedHistory(snapshot, rows, history);
    },
  };
}
