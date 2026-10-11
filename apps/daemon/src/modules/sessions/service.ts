import {
  type Caller,
  type DialogResponse,
  type ForkPoint,
  type HistoryMeta,
  type InitRecord,
  PapError,
  type SessionStatus,
  type SessionStreamEvent,
  type SessionSummary,
  type TranscriptRow,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { PolicyPort } from "../policy/index.ts";
import { resolveSessionCwd } from "./cwd.ts";
import { createForks } from "./forks.ts";
import type { Exports } from "./exports.ts";
import { createGrantLink } from "./grants.ts";
import { type LiveSession, startLiveSession } from "./live-session.ts";
import type { PiWriter } from "./pi-writer.ts";
import { createPreReadyBuffer } from "./pre-ready-buffer.ts";
import { createSessionCommands, type SessionCommands } from "./service-commands.ts";
import { createSessionReads } from "./service-reads.ts";
import { createStoreSync } from "./service-sync.ts";
import type { SessionRow, SessionsStore } from "./store.ts";
import type { TranscriptReader } from "./transcript.ts";

export interface SessionsServiceDeps {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish">;
  /** The project's "always" rules: what every worker starts with, and what an "always" answer is saved in. */
  readonly policy: PolicyPort;
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
  list(caller: Caller): SessionSummary[];
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
    input: { sessionId: string; toolCallId: string },
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
}

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
    hub: deps.hub,
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

  const { bindPiFile, recordEvent, syncName, replayPreReady } = createStoreSync({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    hub: deps.hub,
    agentDir: deps.worker.agentDir,
  });

  // `row` is stored when the worker is ready for a new session (a failed start leaves no trace), and already
  // stored when a cold session is reopened. What a new session's worker says before its row exists is held in a
  // small bounded buffer and replayed once the row is stored; a start that fails drops it with the rest.
  async function launch(row: SessionRow, isNew: boolean): Promise<LiveSession> {
    checkCapacity();
    let stored = !isNew;
    const preReady = isNew ? createPreReadyBuffer() : null;
    let bound = row.piPath !== null;
    const scope = grants.scopeOf(row.cwd);
    const init: InitRecord = {
      type: "init",
      cwd: row.cwd,
      agentDir: deps.worker.agentDir,
      papHome: deps.worker.papHome,
      umask: deps.worker.umask,
      policy: grants.policyFor(row, scope),
      // Only a file this session has recorded is reopened. A draft has none: Pi starts a new session for it.
      ...(row.piPath ? { sessionFile: row.piPath } : {}),
      ...(deps.worker.testProviderScript ? { testProviderScript: deps.worker.testProviderScript } : {}),
    };
    const logger = deps.logger.child({ component: "session", sessionId: row.id });
    // A reopened session has subscribers who last saw it cold; a new one has none yet (R112).
    if (!isNew) deps.hub.publish("session", row.id, { kind: "status", status: "starting" });
    const session: LiveSession = startLiveSession(
      {
        handle: deps.spawn(row.cwd),
        clock: deps.clock,
        logger,
        publish: (event) => {
          if (stored) deps.hub.publish("session", row.id, event);
          // A status is not held: the snapshot carries the status, and no one can have seen an earlier one.
          else if (event.kind !== "status") preReady?.add({ kind: "publish", event });
        },
        record: (kind, data) => {
          if (stored) recordEvent(row.id, kind, data);
          else preReady?.add({ kind: "record", recordKind: kind, data });
        },
        idleMs: deps.idleMs,
        // Before the row exists the name is taken from the session once it is ready (below).
        onName: (name) => {
          if (stored) syncName(row.id, name);
        },
        onActivity: () => {
          if (stored && !bound) bound = bindPiFile(row, session);
        },
        onExit: () => {
          if (live.get(row.id) === session) live.delete(row.id);
        },
        onWorkerExit: (info) => deps.onWorkerExit?.(row.id, info),
      },
      init,
    );
    // Nothing awaits between the rules in `init` and here, so a change cannot fall between the two.
    grants.track(session, row, scope);
    starting.add(session);
    try {
      await session.ready;
      // The file of a recorded session says who it is. Another id means the file was replaced under us.
      if (row.piSessionId !== null && session.piSessionId() !== row.piSessionId)
        throw new PapError("worker_failed");
      if (isNew) deps.store.insert(row);
      stored = true;
      // `ready` said Pi's name before the row could hold it (a new session) or this worker's start may have changed it.
      syncName(row.id, session.name());
      if (preReady) replayPreReady(row.id, preReady.drain());
      // Whoever watches the session while it was cold saw the cached name (R112).
      if (session.name() !== row.name)
        deps.hub.publish("session", row.id, { kind: "name", name: session.name() });
      live.set(row.id, session);
      bound = bound || bindPiFile(row, session);
      return session;
    } catch (error) {
      await session.stop();
      throw error;
    } finally {
      starting.delete(session);
    }
  }

  // A session being released has a worker that drops what it is sent: it is waited for, and the next worker opens the
  // same Pi file. `onExit` has forgotten the session by the time `exited()` resolves, so the second look finds none.
  async function ensureLive(row: SessionRow): Promise<LiveSession> {
    const closing = live.get(row.id);
    // No deadline of its own: the worker's kill ladder ends it within seconds (spec C 2.5).
    if (closing?.status() === "releasing") await closing.exited();
    const current = live.get(row.id);
    if (current) return current;
    const pending = reopening.get(row.id);
    if (pending) return pending;
    const reopened = launch(row, false);
    reopening.set(row.id, reopened);
    try {
      return await reopened;
    } finally {
      reopening.delete(row.id);
    }
  }

  const owned = (sessionId: string, caller: Caller): SessionRow => {
    const row = deps.store.get(sessionId);
    if (!row || row.ownerId !== caller.userId) throw new PapError("not_found");
    return row;
  };

  // The worker a dialog or a panel answer may go to: none once it is being released, whose dialogs closed with it.
  const openWorker = (id: string): LiveSession => {
    const session = live.get(id);
    if (!session || session.status() === "releasing") throw new PapError("not_found");
    return session;
  };

  const statusOf = (id: string): SessionStatus =>
    live.get(id)?.status() ?? (reopening.has(id) ? "starting" : "cold");

  const reads = createSessionReads({
    store: deps.store,
    agentDir: deps.worker.agentDir,
    loadTranscript: deps.loadTranscript,
    live,
    statusOf,
    owned,
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
  });

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
      return { sessionId: row.id };
    },
    list: (caller) =>
      deps.store.listByOwner(caller.userId).map((row) => ({
        id: row.id,
        cwd: row.cwd,
        name: row.name,
        status: statusOf(row.id),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    async prompt(input, caller) {
      const row = owned(input.sessionId, caller);
      const session = await ensureLive(row);
      deps.store.touch(row.id, deps.clock.now());
      return session.prompt(input.text, input.streamingBehavior);
    },
    async abort(sessionId, caller) {
      owned(sessionId, caller);
      // A worker being released has no run, and a closing one drops requests (M2R112).
      const session = live.get(sessionId);
      if (session && session.status() !== "releasing") await session.abort();
    },
    navigate: (input, caller) => commands.navigate(input, caller),
    compact: (input, caller) => commands.compact(input, caller),
    rename: (input, caller) => commands.rename(input, caller),
    autoName: (sessionId, caller) => commands.autoName(sessionId, caller),
    exportHtml: (sessionId, caller) => commands.exportHtml(sessionId, caller),
    fork: async ({ sessionId, entryId }, caller) => forks.fork(owned(sessionId, caller), entryId),
    clone: async ({ sessionId }, caller) => {
      const row = owned(sessionId, caller);
      return forks.clone(row, live.get(row.id)?.leafId() ?? null);
    },
    async clearQueue(sessionId, caller) {
      owned(sessionId, caller);
      const session = live.get(sessionId);
      // A worker being released has an empty queue and drops requests: nothing to ask it (M2-RT-39).
      if (!session || session.status() === "releasing")
        return { steering: [], followUp: [], truncated: false };
      return session.clearQueue();
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
      grants.stop();
      await Promise.allSettled([...live.values(), ...starting].map((session) => session.stop()));
    },
    inspect(sessionId) {
      const session = live.get(sessionId);
      return session ? { pid: session.pid(), rssMb: session.rssMb() } : null;
    },
  };
}
