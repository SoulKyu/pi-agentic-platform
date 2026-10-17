import type {
  ApprovalMode,
  Caller,
  Cursor,
  DialogResponse,
  ForkPoint,
  HistoryMeta,
  MarkChange,
  SessionStreamEvent,
  SessionSummary,
  ShellSession,
  ShellStreamEvent,
  ToolPreset,
  TranscriptRow,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { AuditPort } from "../audit/index.ts";
import type { AttachmentsPort } from "../files/index.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import type { RunObserver } from "../runs/index.ts";
import type { SessionsAgentPort } from "./agent-port.ts";
import type { SessionsChildPort } from "./child-port.ts";
import type { AgentSurface } from "./agent-surface.ts";
import type { SessionsAutomationPort } from "./automation-port.ts";
import type { Exports } from "./exports.ts";
import type { LaneHooksSlot } from "./lane-hooks.ts";
import type { LaneProbe } from "./lane-port.ts";
import type { Admission } from "./fork-quota.ts";
import type { PiWriter } from "./pi-writer.ts";
import type { ReleaseResult } from "./restart-folder.ts";
import type { SessionsScanPort } from "./scan-port.ts";
import type { SessionCommands } from "./service-commands.ts";
import type { SessionModels } from "./service-models.ts";
import type { SessionsStore } from "./store.ts";
import type { TranscriptReader } from "./transcript.ts";

export interface SessionsServiceDeps {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish">;
  /** The project's "always" rules: what every worker starts with, and what an "always" answer is saved in. */
  readonly policy: PolicyPort;
  /** Where a worker's audit entries go (Task 10). */
  readonly audit: AuditPort;
  /** The claims of pending uploads: a prompt's attachments (M8R43). */
  readonly attachments: AttachmentsPort;
  /** What the daemon knows of the workers' containment: "scope" when each runs in a systemd scope. */
  readonly containment: "scope" | "none";
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
  /** A write outside pap added tool results to a session's file: the policy module taints it (M7R27). */
  onOutsideToolResults(sessionId: string): void;
  /** The lanes module's hooks around a prompt and a run's end (M9R114); none: a prompt goes at once. */
  readonly laneHooks?: Pick<LaneHooksSlot, "beforePrompt" | "published" | "waiting" | "assertOwn">;
  /** Loads the reader of Pi's session files; the SDK behind it is heavy, so it is asked for when first needed. */
  loadTranscript(): Promise<TranscriptReader>;
  /** Loads the writer of forks and clones: Pi's own session manager, behind a lazy import (R108, ADR 0009). */
  loadWriter(): Promise<PiWriter>;
  /** `env`: variables for this worker only, over the daemon's (memory trust, M11R142). */
  spawn(cwd: string, env?: Readonly<Record<string, string>>): WorkerHandle;
  freeMemMb(): number;
  onWorkerExit?(sessionId: string, info: { exit: WorkerExit; outputTail: string }): void;
  /** The runs registry: sees each run start and end and every raw Pi event of the session (M10R84). */
  readonly runs?: RunObserver;
  /** The fork cap and the free-disk floor (M10R100, M10R101); the daemon always gives it. */
  readonly admission?: Admission;
}

export interface PromptInput {
  readonly sessionId: string;
  readonly text: string;
  readonly streamingBehavior?: "steer" | "followUp" | undefined;
  /** Pending uploads to claim for this prompt (M8R40). */
  readonly attachments?: readonly string[] | undefined;
  /**
   * Internal callers only (never on the wire): asked once, synchronously, right before the prompt goes to the worker,
   * after a cold session's reopen and the lane hooks. False: the prompt is dropped and the answer is `handled` (a task
   * that was cancelled or stopped meanwhile must not send its prompt, N1).
   */
  readonly stillWanted?: (() => boolean) | undefined;
}

export interface SessionsService extends SessionCommands, SessionModels {
  /** `preset`: the session's tool preset from the start (M7R76); none follows Pi's default tools. */
  create(cwd: string, caller: Caller, preset?: ToolPreset): Promise<{ sessionId: string }>;
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
  /** Brings a cold session's worker back; a live one is left alone. Refused with `capacity` when the cap is reached. */
  reopen(sessionId: string, caller: Caller): Promise<void>;
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
   * and loads the transcript reader, once. The hub builds a snapshot synchronously, from what this has loaded. Answers
   * the cursor to open the subscription with: `after`, except when the file was written outside pap (a fresh snapshot).
   */
  prepareSubscription(sessionId: string, caller: Caller, after?: Cursor): Promise<Cursor | undefined>;
  /**
   * Throws `not_found` for a session that does not exist: the stream hub calls it for every key a client names (R79).
   * Throws `internal` if no subscription was prepared first, rather than show an empty transcript.
   */
  snapshot(sessionId: string): SessionStreamEvent;
  shutdownAll(): Promise<void>;
  inspect(sessionId: string): { pid: number | undefined; rssMb: number | null } | null;
  /**
   * Lets go of the owner's workers in `folder` (a real path) or below, so that the next prompt opens one that reads the
   * new trust decision (M7R105): the idle ones now, the others when their run is over. Answers how many that concerns.
   */
  restartFolder(ownerId: string, folder: string): number;
  /** Stops the worker of the owner's session when it is quiet (M9R113, M10R154): `released`, `busy` (left alone) or `cold` (no worker). */
  releaseIdle(ownerId: string, sessionId: string): ReleaseResult;
  /** What the lane port reads of live sessions and files (M9R37). */
  readonly laneProbe: LaneProbe;
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

/** The service as the module builds it: the RPC handlers need `SessionsService`, the automation module also this port. */
export interface SessionsServiceWithAutomation extends SessionsService {
  /** What the automation and runs modules may do to a session, and nothing more (M10R32). */
  readonly automation: SessionsAutomationPort;
  /** Session kinds, the platform bridge's port and the approved calls (M11). */
  readonly agent: AgentSurface;
  /** What the agents module and the runner may do to the sessions of agents (M11R50). */
  readonly agentSessions: SessionsAgentPort;
  readonly child: SessionsChildPort;
  /** The mode in force for a session: the effective mode of an agent thread (W5-R23), else the session's own. */
  modeOf(ownerId: string, sessionId: string): ApprovalMode;
}
