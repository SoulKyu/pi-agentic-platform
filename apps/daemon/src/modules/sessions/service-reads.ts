import {
  type Caller,
  PapError,
  type SessionStatus,
  type SessionStreamEvent,
  type TranscriptRow,
} from "@pap/contracts";
import { isPiSessionFile } from "./pi-files.ts";
import type { BranchPage } from "./branch.ts";
import { fitSnapshot, SNAPSHOT_ROWS, withTrimmedHistory } from "./snapshot.ts";
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

  return {
    ensureReader,
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
      // A draft's file is the one its worker reported; it is read only if it is where Pi keeps session files.
      const reported = session?.piFile();
      const file = row.piPath ?? (reported && isPiSessionFile(deps.agentDir, reported) ? reported : null);
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
