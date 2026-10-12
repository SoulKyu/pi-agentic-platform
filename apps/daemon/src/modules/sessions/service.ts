import {
  type Caller,
  type DialogResponse,
  type ForkPoint,
  type HistoryMeta,
  type MarkChange,
  PapError,
  type SessionStatus,
  type SessionStreamEvent,
  type SessionSummary,
  type ShellSession,
  type ShellStreamEvent,
  type TranscriptRow,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { ProjectsPort } from "../projects/index.ts";
import { resolveSessionCwd } from "./cwd.ts";
import { createForks } from "./forks.ts";
import type { Exports } from "./exports.ts";
import { createGrantLink } from "./grants.ts";
import { createProjectLink } from "./project-link.ts";
import type { LiveSession } from "./live-session.ts";
import { createOrganiser } from "./organiser.ts";
import { createAdoption } from "./service-adopt.ts";
import type { SessionsScanPort } from "./scan-port.ts";
import type { PiWriter } from "./pi-writer.ts";
import { createSessionCommands, type SessionCommands } from "./service-commands.ts";
import { createLaunch } from "./service-launch.ts";
import { createSessionMarks } from "./service-marks.ts";
import { createSessionReads } from "./service-reads.ts";
import { createShellView } from "./service-shell.ts";
import { createShellPublisher } from "./shell-publisher.ts";
import { fitSummaries } from "./shell.ts";
import type { SessionRow, SessionsStore } from "./store.ts";
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

// What changes a sidebar summary: the status, an open dialog or approval, the name (M4R34).
const SUMMARY_EVENTS: ReadonlySet<string> = new Set(["status", "dialog_open", "dialog_closed", "name"]);

export function createSessionsService(deps: SessionsServiceDeps): SessionsService {
  // Workers that are up, by session id. A crashed worker leaves this map and is not replaced until the next prompt.
  const live = new Map<string, LiveSession>();
  // A cold session being brought up, so that concurrent commands start one worker, not several.
  const reopening = new Map<string, Promise<LiveSession>>();
  // Workers between fork and `ready`. They count against the cap like running ones (R9).
  const starting = new Set<LiveSession>();
  let closing = false;
  const grants = createGrantLink({
    policy: deps.policy,
    clock: deps.clock,
    logger: deps.logger,
    sessions: () => [...live.values(), ...starting],
  });

  const checkCapacity = () => {
    if (
      closing ||
      live.size + starting.size >= deps.limits.maxWorkers ||
      deps.freeMemMb() < deps.limits.minFreeMemMb
    ) {
      throw new PapError("capacity");
    }
  };

  const marks = deps.store.marks;
  const link = createProjectLink({
    store: marks,
    projects: deps.projects,
    scopeOf: deps.policy.scopeOf,
    logger: deps.logger,
  });

  const statusOf = (id: string): SessionStatus =>
    live.get(id)?.status() ?? (reopening.has(id) ? "starting" : "cold");

  const shell = createShellView({
    store: marks,
    projects: deps.projects,
    live: (id) => ({ status: statusOf(id), needsInput: (live.get(id)?.dialogs().length ?? 0) > 0 }),
  });
  const publisher = createShellPublisher({
    hub: deps.hub,
    summary: shell.summary,
    project: shell.project,
    archivedCount: marks.countArchived,
    logger: deps.logger,
    clock: deps.clock,
  });
  deps.projects.onChange((ownerId, view) => publisher.projectChanged(ownerId, view.id));
  const organiser = createOrganiser({
    store: marks,
    clock: deps.clock,
    logger: deps.logger,
    publisher,
    isLive: (id) => live.has(id),
    readOnly: deps.store.readOnly,
  });

  const adoption = createAdoption({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    agentDir: deps.worker.agentDir,
    newId: deps.newId,
    ownerId: deps.ownerId,
    ...(deps.onAdopted ? { onAdopted: deps.onAdopted } : {}),
    live,
    link,
    publisher,
    activity: organiser.activity,
    summary: shell.summaryFor,
  });

  const { launch, ensureLive } = createLaunch({
    deps,
    live,
    reopening,
    starting,
    grants,
    checkCapacity,
    projectFor: (row) => link.projectOf(row.ownerId, row.cwd),
    onReopened: (sessionId) => publisher.changed(sessionId),
    onPublished: (sessionId, event) => {
      // A run starting is activity: the session leaves Settled and Snoozed (M4R41).
      if (event.kind === "status" && event.status === "running") organiser.activity(sessionId);
      if (SUMMARY_EVENTS.has(event.kind)) publisher.changed(sessionId);
    },
    ...adoption.launchHooks,
  });

  const owned = (sessionId: string, caller: Caller): SessionRow => {
    const row = deps.store.get(sessionId);
    if (!row || row.ownerId !== caller.userId) throw new PapError("not_found");
    return row;
  };

  // The worker a dialog or a panel answer may go to: none once it is being released, whose dialogs closed with it.
  const openWorker = (id: string): LiveSession => {
    const session = live.get(id);
    if (!session || session.stopping()) throw new PapError("not_found");
    return session;
  };

  const reads = createSessionReads({
    store: deps.store,
    agentDir: deps.worker.agentDir,
    loadTranscript: deps.loadTranscript,
    live,
    statusOf,
    owned,
    outsideWrite: adoption.outsideWrite,
  });

  const commands = createSessionCommands({
    owned,
    ensureLive,
    live,
    reads,
    hub: deps.hub,
    exports: deps.exports,
    logger: deps.logger,
  });
  const forks = createForks({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    agentDir: deps.worker.agentDir,
    newId: deps.newId,
    loadWriter: deps.loadWriter,
    onMade: adoption.fileMade,
  });
  const sessionMarks = createSessionMarks({
    store: marks,
    clock: deps.clock,
    owned,
    publisher,
    onSnoozeChange: organiser.rearm,
  });

  const filed = <T extends { sessionId: string }>(source: SessionRow, result: T): T => {
    const projectId = link.copy(source.id, result.sessionId);
    publisher.changed(result.sessionId);
    publisher.projectChanged(source.ownerId, projectId);
    return result;
  };

  return {
    async create(cwdInput, caller) {
      const cwd = resolveSessionCwd(cwdInput);
      const now = deps.clock.now();
      const row: SessionRow = {
        id: deps.newId(),
        piPath: null,
        piSessionId: null,
        cwd,
        ownerId: caller.userId,
        name: null,
        createdAt: now,
        updatedAt: now,
      };
      await launch(row, true);
      publisher.changed(row.id);
      publisher.projectChanged(caller.userId, marks.row(row.id)?.projectId ?? null);
      return { sessionId: row.id };
    },
    listFitted: (caller) => fitSummaries(reads.summaries(caller)),
    list: (caller) => reads.summaries(caller),
    shellSnapshot: (ownerId) => shell.snapshot(ownerId),
    listArchived: shell.listArchived,
    summary: shell.summaryFor,
    async prompt(input, caller) {
      const row = owned(input.sessionId, caller);
      const session = await ensureLive(row);
      deps.store.touch(row.id, deps.clock.now());
      organiser.activity(row.id);
      publisher.changed(row.id);
      return session.prompt(input.text, input.streamingBehavior);
    },
    async abort(sessionId, caller) {
      owned(sessionId, caller);
      // A closing worker answers ok without being asked (M2R112): the live session sees to it.
      await live.get(sessionId)?.abort();
    },
    navigate: (input, caller) => commands.navigate(input, caller),
    compact: (input, caller) => commands.compact(input, caller),
    rename: (input, caller) => commands.rename(input, caller),
    autoName: (sessionId, caller) => commands.autoName(sessionId, caller),
    exportHtml: (sessionId, caller) => commands.exportHtml(sessionId, caller),
    fork: async ({ sessionId, entryId }, caller) => {
      const row = owned(sessionId, caller);
      return filed(row, await forks.fork(row, entryId));
    },
    clone: async ({ sessionId }, caller) => {
      const row = owned(sessionId, caller);
      return filed(row, await forks.clone(row, live.get(row.id)?.leafId() ?? null));
    },
    async clearQueue(sessionId, caller) {
      owned(sessionId, caller);
      // A closing worker has an empty queue and drops requests: the live session answers without asking it (M2-RT-39).
      return (await live.get(sessionId)?.clearQueue()) ?? { steering: [], followUp: [], truncated: false };
    },
    respondDialog(input, caller) {
      owned(input.sessionId, caller);
      const session = openWorker(input.sessionId);
      grants.answered(session, session.answer(input.dialogId, input.response));
    },
    panelInput(input, caller) {
      owned(input.sessionId, caller);
      openWorker(input.sessionId).panelInput(input.panelId, input.data);
    },
    history: (input, caller) => reads.history(input, caller),
    toolOutput: (input, caller) => reads.toolOutput(input, caller),
    branches: (sessionId, caller) => reads.branches(sessionId, caller),
    prepareSubscription: (sessionId, caller) => reads.prepare(sessionId, caller),
    snapshot: (sessionId) => reads.snapshot(sessionId),
    async shutdownAll() {
      closing = true;
      organiser.stop();
      grants.stop();
      await Promise.allSettled([...live.values(), ...starting].map((session) => session.stop()));
    },
    inspect(sessionId) {
      const session = live.get(sessionId);
      return session ? { pid: session.pid(), rssMb: session.rssMb() } : null;
    },
    mark: (input, caller) => sessionMarks.mark(input, caller),
    startOrganiser: organiser.start,
    activity: organiser.activity,
    backfillProjects: () => (deps.store.readOnly ? 0 : link.backfill()),
    scanPort: adoption.scanPort,
  };
}
