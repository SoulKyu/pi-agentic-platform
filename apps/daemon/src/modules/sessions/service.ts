import {
  type Caller,
  type DialogResponse,
  type InitRecord,
  PapError,
  type PolicyRules,
  type SessionStatus,
  type SessionStreamEvent,
  type SessionSummary,
} from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { resolveSessionCwd } from "./cwd.ts";
import { type LiveSession, startLiveSession } from "./live-session.ts";
import { fileSizeOrZero, isPiSessionFile } from "./pi-files.ts";
import { createPreReadyBuffer, type PreReadyBuffer } from "./pre-ready-buffer.ts";
import { createSessionReads } from "./service-reads.ts";
import type { SessionRow, SessionsStore } from "./store.ts";
import type { TranscriptReader } from "./transcript.ts";

const INTERACTIVE_POLICY: PolicyRules = {
  profile: "interactive",
  approvalMode: "auto-accept-edits",
  alwaysAllow: [],
};

export interface SessionsServiceDeps {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish">;
  readonly limits: { readonly maxWorkers: number; readonly minFreeMemMb: number };
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
  spawn(cwd: string): WorkerHandle;
  freeMemMb(): number;
  onWorkerExit?(sessionId: string, info: { exit: WorkerExit; outputTail: string }): void;
}

export interface PromptInput {
  readonly sessionId: string;
  readonly text: string;
  readonly streamingBehavior?: "steer" | "followUp" | undefined;
}

export interface SessionsService {
  create(cwd: string, caller: Caller): Promise<{ sessionId: string }>;
  list(caller: Caller): SessionSummary[];
  prompt(input: PromptInput, caller: Caller): Promise<{ disposition: "started" | "queued" | "handled" }>;
  abort(sessionId: string, caller: Caller): Promise<void>;
  respondDialog(
    input: { sessionId: string; dialogId: string; response: DialogResponse },
    caller: Caller,
  ): void;
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

  const checkCapacity = () => {
    if (
      closing ||
      live.size + starting.size >= deps.limits.maxWorkers ||
      deps.freeMemMb() < deps.limits.minFreeMemMb
    ) {
      throw new PapError("capacity");
    }
  };

  // Pi writes a session's file with the first user message, not at creation (S1). Once it exists, the session
  // remembers it: that is what a restart reopens. Returns true when there is nothing left to wait for.
  function bindPiFile(row: SessionRow, session: LiveSession): boolean {
    const file = session.piFile();
    const piSessionId = session.piSessionId();
    if (!file || !piSessionId || fileSizeOrZero(file) === 0) return false;
    if (!isPiSessionFile(deps.worker.agentDir, file)) {
      deps.logger.warn("session_file_refused", { sessionId: row.id });
      return true;
    }
    try {
      deps.store.bindPiFile(row.id, file, piSessionId);
    } catch (error) {
      deps.logger.warn("session_file_not_bound", { sessionId: row.id, err: error });
    }
    return true;
  }

  function recordEvent(sessionId: string, kind: string, data: unknown): void {
    try {
      deps.store.appendEvent(sessionId, kind, data, deps.clock.now());
    } catch (error) {
      deps.logger.warn("session_event_dropped", { sessionId, kind, err: error });
    }
  }

  function replayPreReady(sessionId: string, held: ReturnType<PreReadyBuffer["drain"]>): void {
    for (const item of held.items) {
      if (item.kind === "publish") deps.hub.publish("session", sessionId, item.event);
      else recordEvent(sessionId, item.recordKind, item.data);
    }
    if (held.dropped > 0)
      deps.logger.warn("session_start_events_dropped", { sessionId, dropped: held.dropped });
  }

  // `row` is stored when the worker is ready for a new session (a failed start leaves no trace), and already
  // stored when a cold session is reopened. What a new session's worker says before its row exists is held in a
  // small bounded buffer and replayed once the row is stored; a start that fails drops it with the rest.
  async function launch(row: SessionRow, isNew: boolean): Promise<LiveSession> {
    checkCapacity();
    let stored = !isNew;
    const preReady = isNew ? createPreReadyBuffer() : null;
    let bound = row.piPath !== null;
    const init: InitRecord = {
      type: "init",
      cwd: row.cwd,
      agentDir: deps.worker.agentDir,
      papHome: deps.worker.papHome,
      umask: deps.worker.umask,
      policy: INTERACTIVE_POLICY,
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
    starting.add(session);
    try {
      await session.ready;
      // The file of a recorded session says who it is. Another id means the file was replaced under us.
      if (row.piSessionId !== null && session.piSessionId() !== row.piSessionId)
        throw new PapError("worker_failed");
      if (isNew) deps.store.insert(row);
      stored = true;
      if (preReady) replayPreReady(row.id, preReady.drain());
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

  async function ensureLive(row: SessionRow): Promise<LiveSession> {
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
      await live.get(sessionId)?.abort();
    },
    respondDialog(input, caller) {
      owned(input.sessionId, caller);
      const session = live.get(input.sessionId);
      if (!session) throw new PapError("not_found");
      session.answer(input.dialogId, input.response);
    },
    prepareSubscription: (sessionId, caller) => reads.prepare(sessionId, caller),
    snapshot: (sessionId) => reads.snapshot(sessionId),
    async shutdownAll() {
      closing = true;
      await Promise.allSettled([...live.values(), ...starting].map((session) => session.stop()));
    },
    inspect(sessionId) {
      const session = live.get(sessionId);
      return session ? { pid: session.pid(), rssMb: session.rssMb() } : null;
    },
  };
}
