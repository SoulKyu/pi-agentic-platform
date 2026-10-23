import { HEALTH_TABLE, type Caller, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { HealthEvents } from "../health/index.ts";
import type { SessionsAgentPort } from "../sessions/index.ts";
import type { AuditPort } from "../audit/index.ts";
import type { AgentLinks } from "./links.ts";
import type { AgentStore } from "./store.ts";
import { actorOf } from "./view.ts";

/**
 * What the delete and the thread's open tell each other (M11R59, M11R183). Both sets are bounded by the agent cap:
 * an agent is in each at most once, and leaves it when its call ends.
 */
export interface AgentGuard {
  /** Agents with a delete in flight: nothing opens a thread for one of them. */
  readonly deleting: Set<string>;
  /** Agents with a thread being created: a delete of one is `session_busy`. */
  readonly opening: Set<string>;
  /** Agents with quarantines queued or running, and how many: a resume of one is `session_busy` until the last ends. */
  readonly quarantining: Map<string, number>;
}

export const createAgentGuard = (): AgentGuard => ({
  deleting: new Set(),
  opening: new Set(),
  quarantining: new Map(),
});

export interface ThreadsDeps {
  readonly store: Pick<AgentStore, "get" | "setThread" | "clearThread">;
  readonly sessions: Pick<SessionsAgentPort, "createAgentSession" | "threadState">;
  readonly guard: AgentGuard;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
  /** Read at each call: the links are bound after the module is built. */
  readonly links: () => AgentLinks;
  /** The agent's rail entry may have changed. */
  changed(ownerId: string, agentId: string): void;
  readonly audit: Pick<AuditPort, "append">;
  /** The health events (Task 3): a refused agent launch the owner may page on. */
  readonly health?: Pick<HealthEvents, "emit">;
}

/**
 * The agent's one trusted thread (M11R59, M11R60). Open and reset of an agent run one after the other, so two opens at
 * once get the same session. The thread's worker only ever starts through `createAgentSession`, which goes through the
 * launch gate (W5-R26).
 */
export function createThreads(deps: ThreadsDeps) {
  const { store, sessions, guard } = deps;
  // The tail of each agent's chain; an entry leaves when its tail ends.
  const tails = new Map<string, Promise<unknown>>();
  // The refusal codes of the agent kind: a launch refused with one of them is pageable (Task 3).
  const agentRefusals = new Set<string>(HEALTH_TABLE.filter((r) => r.kind === "agent").map((r) => r.code));

  /** The health event of a refused launch: the refusal still happens, next to it. */
  function agentHealth(ownerId: string, record: { id: string; name: string }, code: string): void {
    deps.health?.emit({
      ownerId,
      kind: "agent",
      code,
      sourceRef: { kind: "agent", id: record.id, name: record.name },
    });
  }

  function serial<T>(agentId: string, work: () => Promise<T> | T): Promise<T> {
    const run = (tails.get(agentId) ?? Promise.resolve()).then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(agentId, tail);
    void tail.then(() => {
      if (tails.get(agentId) === tail) tails.delete(agentId);
    });
    return run;
  }

  async function openOnce(ownerId: string, agentId: string): Promise<{ sessionId: string }> {
    const record = store.get(ownerId, agentId);
    if (!record) throw new PapError("not_found");
    if (record.quarantinedAt !== null) {
      agentHealth(ownerId, record, "agent_paused");
      throw new PapError("agent_paused");
    }
    if (guard.deleting.has(agentId)) throw new PapError("session_busy");
    if (record.threadSessionId !== null) {
      const state = sessions.threadState(ownerId, record.threadSessionId);
      if (state && !state.archived) return { sessionId: record.threadSessionId };
    }
    guard.opening.add(agentId);
    try {
      const { sessionId } = await sessions.createAgentSession({ ownerId, agentId, role: "thread" });
      // The row is read again by the statement itself: it still names the thread this call replaced.
      if (!store.setThread(ownerId, agentId, record.threadSessionId, sessionId)) {
        discard(ownerId, sessionId);
        throw new PapError("conflict");
      }
      deps.changed(ownerId, agentId);
      return { sessionId };
    } catch (error) {
      if (error instanceof PapError && agentRefusals.has(error.code))
        agentHealth(ownerId, record, error.code);
      throw error;
    } finally {
      guard.opening.delete(agentId);
    }
  }

  /** A session no agent row names: archived and let go, so it neither shows nor holds a worker. */
  function discard(ownerId: string, sessionId: string): void {
    const threads = deps.links().threads;
    try {
      threads?.archive(ownerId, sessionId);
      threads?.releaseIdle(ownerId, sessionId);
    } catch (error) {
      deps.logger.warn("agent_thread_discard_failed", { err: error });
    }
  }

  function resetOnce(caller: Caller, agentId: string): void {
    const ownerId = caller.userId;
    const record = store.get(ownerId, agentId);
    if (!record) throw new PapError("not_found");
    if (guard.deleting.has(agentId) || guard.opening.has(agentId)) throw new PapError("session_busy");
    const sessionId = record.threadSessionId;
    const threads = deps.links().threads;
    if (sessionId !== null) {
      const state = sessions.threadState(ownerId, sessionId);
      // Nothing is awaited from this check to the clear: no prompt can slip in between.
      if (state && (state.running || state.starting || state.needsInput)) throw new PapError("session_busy");
      if (threads?.busy(ownerId, sessionId)) throw new PapError("session_busy");
      threads?.archive(ownerId, sessionId);
      threads?.releaseIdle(ownerId, sessionId);
    }
    store.clearThread(ownerId, agentId, deps.clock.now());
    try {
      deps.links().inbox?.clearReply(ownerId, agentId);
    } catch (error) {
      deps.logger.warn("agent_reply_clear_failed", { err: error });
    }
    // The waiting one-use values belong to the archived thread's session: they go with it (Task 18).
    try {
      deps.links().onceValues?.drop(ownerId, agentId);
    } catch (error) {
      deps.logger.warn("agent_once_drop_failed", { err: error });
    }
    deps.audit.append({
      ownerId,
      ...actorOf(caller),
      kind: "policy",
      reason: "agent thread reset",
      detail: { agentId },
    });
    deps.changed(ownerId, agentId);
  }

  return {
    /** Runs `work` between the agent's opens and resets (quarantine, M11R115): none starts inside it, none is lost. */
    locked: <T>(agentId: string, work: () => Promise<T> | T): Promise<T> => serial(agentId, work),
    /** The agent's thread session: the one it has, or a new one (`agent_paused` for a quarantined agent). */
    open: (ownerId: string, agentId: string): Promise<{ sessionId: string }> =>
      serial(agentId, () => openOnce(ownerId, agentId)),
    /** Archives the thread and forgets it; the profile, home, triggers and queued tasks stay (M11R60). */
    reset: (caller: Caller, agentId: string): Promise<void> =>
      serial(agentId, () => resetOnce(caller, agentId)),
  };
}
export type Threads = ReturnType<typeof createThreads>;
