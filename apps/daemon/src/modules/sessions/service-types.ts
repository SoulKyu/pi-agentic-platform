import type {
  Caller,
  DialogResponse,
  ForkPoint,
  HistoryMeta,
  MarkChange,
  SessionStreamEvent,
  SessionSummary,
  ShellSession,
  ShellStreamEvent,
  TranscriptRow,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { Exports } from "./exports.ts";
import type { PiWriter } from "./pi-writer.ts";
import type { SessionsScanPort } from "./scan-port.ts";
import type { SessionCommands } from "./service-commands.ts";
import type { SessionsStore } from "./store.ts";
import type { TranscriptReader } from "./transcript.ts";

export interface SessionsServiceDeps {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish">;
  /** The project's "always" rules: what every worker starts with, and what an "always" answer is saved in. */
  readonly policy: PolicyPort;
  /** Where a session's project is made (Task 6): one per folder scope, on demand. */
  readonly projects: ProjectsPort;
  /** The pending HTML exports (ADR 0006). */
  readonly exports: Pick<Exports, "prepare" | "discard">;
  readonly limits: { readonly maxWorkers: number; readonly minFreeMemMb: number };
  /** Idle minutes after which a worker is released (spec C 2.1), in milliseconds; 0 or less turns the release off. */
  readonly idleMs: number;
  readonly worker: {
    readonly agentDir: string;
    readonly papHome: string;
    /** The umask the daemon was started with: workers run their tools under it, not under the daemon's own 077. */
    readonly umask: number;
    readonly testProviderScript: string | null;
  };
  newId(): string;
  /** The instance owner, whom adopted sessions belong to (M4R61); null before setup. */
  ownerId(): string | null;
  onAdopted?(sessionId: string): void;
  /** Loads the reader of Pi's session files; the SDK behind it is heavy, so it is asked for when first needed. */
  loadTranscript(): Promise<TranscriptReader>;
  /** Loads the writer of forks and clones: Pi's own session manager, behind a lazy import (R108, ADR 0009). */
  loadWriter(): Promise<PiWriter>;
  spawn(cwd: string): WorkerHandle;
  freeMemMb(): number;
  onWorkerExit?(sessionId: string, info: { exit: WorkerExit; outputTail: string }): void;
}

export interface PromptInput {
  readonly sessionId: string;
  readonly text: string;
  readonly streamingBehavior?: "steer" | "followUp" | undefined;
}

export interface SessionsService extends SessionCommands {
  create(cwd: string, caller: Caller): Promise<{ sessionId: string }>;
  /** Every session of the caller, unbounded: tests and internal use only; RPC handlers use `listFitted`. */
  list(caller: Caller): SessionSummary[];
  /** `list` cut to the page in JSON bytes, the newest kept (M4R35). */
  listFitted(caller: Caller): { sessions: SessionSummary[]; truncated: boolean };
  /** The caller's own sidebar: what a `shell` subscription starts from. Filtered by the owner id the transport gave. */
  shellSnapshot(ownerId: string): ShellStreamEvent;
  /** Archived sessions of the caller, newest archive first, by `(archivedAt, id)`. */
  listArchived(
    caller: Caller,
    params: { before?: { archivedAt: number; id: string } | undefined; limit?: number | undefined },
  ): { sessions: ShellSession[]; hasMore: boolean };
  /** A session's sidebar summary, only when `ownerId` owns it. */
  summary(sessionId: string, ownerId: string): ShellSession | null;
  prompt(input: PromptInput, caller: Caller): Promise<{ disposition: "started" | "queued" | "handled" }>;
  abort(sessionId: string, caller: Caller): Promise<void>;
  /** Empties the steering queue of a session the caller owns; a cold session has none (no worker is started). */
  clearQueue(
    sessionId: string,
    caller: Caller,
  ): Promise<{ steering: string[]; followUp: string[]; truncated: boolean }>;
  respondDialog(
    input: { sessionId: string; dialogId: string; response: DialogResponse },
    caller: Caller,
  ): void;
  /**
   * Keystrokes for an open extension panel of a session the caller owns (M2R86). Not a mutation with a receipt: the
   * client never retries one. `not_found` when the session has no worker or the panel is not open.
   */
  panelInput(input: { sessionId: string; panelId: string; data: string }, caller: Caller): void;
  /** Older rows of the branch above `before`; reads of a session the caller owns (`not_found` otherwise). */
  history(
    input: { sessionId: string; before: string; limit?: number | undefined },
    caller: Caller,
  ): Promise<HistoryMeta & { rows: TranscriptRow[] }>;
  toolOutput(
    input: { sessionId: string; toolCallId: string; resultEntryId?: string | undefined },
    caller: Caller,
  ): Promise<{ text: string; truncated: boolean; isError: boolean; args: string | null }>;
  branches(
    sessionId: string,
    caller: Caller,
  ): Promise<{ leafId: string | null; points: ForkPoint[]; truncated: boolean }>;
  /**
   * A new session on a new file, cut before a user message of the session's branch (ADR 0009). Allowed while the source
   * runs and for a cold one: no worker is started, and the new session is cold. At the first message there is no file
   * yet (a draft). `bad_request` for an entry that is not a user message, `session_empty` for a source without a file.
   */
  fork(
    input: { sessionId: string; entryId: string },
    caller: Caller,
  ): Promise<{ sessionId: string; text: string }>;
  /** A new, cold session holding the branch as written on disk (the turn in flight is not in it). */
  clone(input: { sessionId: string }, caller: Caller): Promise<{ sessionId: string }>;
  /**
   * What `subscribe.session` does before it opens a subscription (R108): checks that the caller may read the session
   * and loads the transcript reader, once. The hub builds a snapshot synchronously, from what this has loaded.
   */
  prepareSubscription(sessionId: string, caller: Caller): Promise<void>;
  /**
   * Throws `not_found` for a session that does not exist: the stream hub calls it for every key a client names (R79).
   * Throws `internal` if no subscription was prepared first, rather than show an empty transcript.
   */
  snapshot(sessionId: string): SessionStreamEvent;
  shutdownAll(): Promise<void>;
  inspect(sessionId: string): { pid: number | undefined; rssMb: number | null } | null;
  /**
   * Files a session the caller owns: pin, archive, settle, snooze, or Undo (`restore`). Synchronous (M4R126); the
   * worker is never touched (M4R39). `not_found` for another owner's session, `bad_request`/`limit_reached` from the
   * shared rules, `read_only` when the database is read-only.
   */
  mark(input: { sessionId: string; change: MarkChange }, caller: Caller): void;
  /** Arms the 3-day sweep and the snooze wake timer; nothing in read-only mode. `shutdownAll` stops them. */
  startOrganiser(): void;
  /** Someone worked in the session (a prompt, a run, new entries): it leaves Settled and Snoozed (M4R41). */
  activity(sessionId: string): void;
  /** Files the sessions stored before M4 under their folder's project; 0 and nothing written in read-only mode. */
  backfillProjects(): number;
  /** What the scanner asks of sessions: adoption of Pi files, and what it learns about them (Task 14). */
  readonly scanPort: SessionsScanPort;
}
