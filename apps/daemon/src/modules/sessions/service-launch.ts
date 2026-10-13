import { type InitRecord, PapError, type SessionStreamEvent } from "@pap/contracts";
import type { createGrantLink } from "./grants.ts";
import { type LiveSession, startLiveSession } from "./live-session.ts";
import type { PolicyLink } from "./policy-link.ts";
import { createPreReadyBuffer } from "./pre-ready-buffer.ts";
import type { SessionsServiceDeps } from "./service.ts";
import { createStoreSync } from "./service-sync.ts";
import type { SessionRow } from "./store.ts";

/** What starting a worker needs of the service: its deps and the maps it shares with it (M4R27). */
export interface LaunchContext {
  readonly deps: SessionsServiceDeps;
  readonly live: Map<string, LiveSession>;
  readonly reopening: Map<string, Promise<LiveSession>>;
  readonly starting: Set<LiveSession>;
  readonly grants: ReturnType<typeof createGrantLink>;
  /** What ties the sessions to the policy module: the rules of each worker, its audit hand-over, a refused update. */
  readonly policyLink: PolicyLink;
  checkCapacity(): void;
  /** The project for a new session's row, called once after `ready` and before the row is stored (M4R28). */
  projectFor?(row: SessionRow): string | null;
  /** After `ready`, for a row without a Pi file: the Pi id its worker reported (M4R123). */
  onDraftReady?(sessionId: string, piSessionId: string): void;
  /**
   * After an event reached the session's subscribers. Skipped for what a new session said before its row was stored
   * (replayed from the buffer without it) and for the `status` events of `live-session` while `stored` is false.
   */
  onPublished?(sessionId: string, event: SessionStreamEvent): void;
  /** After a reopen settled, success or failure: `reopening` no longer holds the session, so its status has changed. */
  onReopened?(sessionId: string): void;
  /** In the worker's `onExit`, after `live` forgot the session (owner Q13). */
  onWorkerEnd?(sessionId: string): void;
  /** From the worker's spawn to the end of `launch`, success or failure: its file may be written before `live` holds it. */
  onStarting?(sessionId: string): void;
  onStarted?(sessionId: string): void;
}

/** Starts a session's worker (`launch`) or hands out the one that runs (`ensureLive`). Moved out of `service.ts` as is. */
export function createLaunch(ctx: LaunchContext) {
  const { deps, live, reopening, starting, grants, policyLink } = ctx;
  const { bindPiFile, recordEvent, syncName, replayPreReady } = createStoreSync({
    store: deps.store,
    clock: deps.clock,
    logger: deps.logger,
    hub: deps.hub,
    agentDir: deps.worker.agentDir,
    onPolicyRecord: (row, raw) => policyLink.audited(row, raw),
    onTaint: (row, epoch) => policyLink.tainted(row, epoch),
  });

  // `row` is stored when the worker is ready for a new session (a failed start leaves no trace), and already
  // stored when a cold session is reopened. What a new session's worker says before its row exists is held in a
  // small bounded buffer and replayed once the row is stored; a start that fails drops it with the rest.
  async function launch(row: SessionRow, isNew: boolean): Promise<LiveSession> {
    ctx.checkCapacity();
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
      policy: policyLink.compose(row, scope),
      // Only a file this session has recorded is reopened. A draft has none: Pi starts a new session for it.
      ...(row.piPath ? { sessionFile: row.piPath } : {}),
      ...(deps.worker.testProviderScript ? { testProviderScript: deps.worker.testProviderScript } : {}),
    };
    const logger = deps.logger.child({ component: "session", sessionId: row.id });
    // A reopened session has subscribers who last saw it cold; a new one has none yet (R112).
    if (!isNew) {
      const starting: SessionStreamEvent = { kind: "status", status: "starting" };
      deps.hub.publish("session", row.id, starting);
      ctx.onPublished?.(row.id, starting);
    }
    const session: LiveSession = startLiveSession(
      {
        handle: deps.spawn(row.cwd),
        clock: deps.clock,
        logger,
        publish: (event) => {
          if (stored) {
            deps.hub.publish("session", row.id, event);
            ctx.onPublished?.(row.id, event);
          }
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
          ctx.onWorkerEnd?.(row.id);
        },
        onWorkerExit: (info) => deps.onWorkerExit?.(row.id, info),
        onPolicyRefused: () => policyLink.refused(row, session),
      },
      init,
    );
    // Nothing awaits between the rules in `init` and here, so a change cannot fall between the two.
    grants.track(session, row, scope);
    starting.add(session);
    ctx.onStarting?.(row.id);
    try {
      await session.ready;
      // The file of a recorded session says who it is. Another id means the file was replaced under us.
      if (row.piSessionId !== null && session.piSessionId() !== row.piSessionId)
        throw new PapError("worker_failed");
      if (isNew) deps.store.insert(row, ctx.projectFor?.(row) ?? null);
      stored = true;
      // Pi writes the file with the first message: until then the row keeps the Pi id its worker reported (M4R123).
      const piId = session.piSessionId();
      if (row.piPath === null && piId) ctx.onDraftReady?.(row.id, piId);
      // `ready` said Pi's name before the row could hold it (a new session) or this worker's start may have changed it.
      syncName(row.id, session.name());
      if (preReady) replayPreReady(row.id, preReady.drain());
      // Whoever watches the session while it was cold saw the cached name (R112).
      if (session.name() !== row.name) {
        const named: SessionStreamEvent = { kind: "name", name: session.name() };
        deps.hub.publish("session", row.id, named);
        ctx.onPublished?.(row.id, named);
      }
      live.set(row.id, session);
      bound = bound || bindPiFile(row, session);
      return session;
    } catch (error) {
      await session.stop();
      throw error;
    } finally {
      starting.delete(session);
      ctx.onStarted?.(row.id);
    }
  }

  // A session being released has a worker that drops what it is sent: it is waited for, and the next worker opens the
  // same Pi file. `onExit` has forgotten the session by the time `exited()` resolves, so the second look finds none.
  async function ensureLive(row: SessionRow): Promise<LiveSession> {
    const closing = live.get(row.id);
    // No deadline of its own: the worker's kill ladder ends it within seconds (spec C 2.5).
    if (closing?.stopping()) await closing.exited();
    // One whose exit could not be handled is still listed, and is not a worker to give a prompt to.
    const current = live.get(row.id);
    if (current && !current.stopping()) return current;
    const pending = reopening.get(row.id);
    if (pending) return pending;
    const reopened = launch(row, false);
    reopening.set(row.id, reopened);
    try {
      return await reopened;
    } finally {
      reopening.delete(row.id);
      // The status published during the reopen was read while `reopening` still held the session.
      ctx.onReopened?.(row.id);
    }
  }

  return { launch, ensureLive };
}
