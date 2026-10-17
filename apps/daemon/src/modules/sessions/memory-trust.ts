import type { InitMemory, SessionStreamEvent, SessionType } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { PolicyPort } from "../policy/index.ts";
import type { AgentLaunch } from "./agent-gate.ts";
import type { LiveSession } from "./live-types.ts";
import type { ReleaseResult } from "./restart-folder.ts";

/** What a worker's init record and environment say to pi-mem0 about its session (M11R142). */
export interface MemoryTrustDecision {
  readonly memory?: InitMemory;
  readonly env: Readonly<Record<string, string>>;
}

/** No valid profile: pi-mem0 fails closed (no capture, no save, no forget); capture is also off in its environment. */
const CLOSED: MemoryTrustDecision = {
  memory: { profile: "", trust: "untrusted" },
  env: { PI_MEM0_CAPTURE: "0" },
};

/**
 * Decided once per worker start, from the session's type and its taint then (the egress taint of a clean report
 * never reaches here: only a real taint, stage 07, makes `tainted` true, ADR 0052). Cost if wrong: an untrusted run's
 * content becomes trusted memory, so every type that is not named below is closed.
 */
export function memoryTrustOf(
  kind: { readonly type: SessionType; readonly tainted: boolean },
  launch: Pick<AgentLaunch, "agent" | "input"> | null,
): MemoryTrustDecision {
  const { type, tainted } = kind;
  if (launch && type === "agent-thread" && !tainted)
    return {
      memory: {
        profile: launch.agent.id,
        trust: "trusted",
        ...(launch.input.memory ? { memory: launch.input.memory } : {}),
      },
      env: {},
    };
  if (launch && (type === "agent-thread" || type === "agent-task"))
    return { memory: { profile: launch.agent.id, trust: "untrusted" }, env: {} };
  if ((type === "plain" || type === "lane") && !tainted) return { env: {} };
  return CLOSED;
}

export interface MemoryRelease {
  /**
   * A worker came up with this decision. Only one that got no entry or a trusted one is watched: for any other a reboot
   * changes nothing (children, agent tasks, M10 tasks, sessions already closed).
   */
  started(sessionId: string, decision: MemoryTrustDecision): void;
  ended(sessionId: string): void;
  /** A reopen settled: a release deferred while the worker booted is tried again. */
  reopened(sessionId: string): void;
  /** The session's status events: a run that settles releases a worker waiting for it. */
  published(sessionId: string, event: SessionStreamEvent): void;
  /**
   * Called by `prompt` right before a prompt goes to the worker. pi-mem0 fixes its policy at `session_start` and reads
   * nothing mid-run, so a release that is still pending here is the only barrier left: the idle worker is stopped and
   * the prompt runs on a new one, which starts with the closed or untrusted entry. A running worker is left alone (a
   * steering prompt joins its run). Null when nothing is pending: the caller must not await then, because the busy rule
   * (M2R88) counts on the prompt reaching the worker in the same tick as the worker's arrival.
   */
  renew<R extends { readonly id: string }>(
    row: R,
    session: LiveSession,
    ensureLive: (row: R) => Promise<LiveSession>,
  ): Promise<LiveSession> | null;
  stop(): void;
}

/**
 * M11R143: a worker that started untainted learns pi-mem0's rules at its start only. When its session is tainted, the
 * worker is released as soon as the run settles (at once when it is quiet). Whatever the release could not do then
 * (a dialog open, a queued prompt, a reopen or a start still under way) stays pending and is enforced by `renew`.
 */
export function createMemoryRelease(deps: {
  readonly policy: Pick<PolicyPort, "sessionPolicy" | "onSessionChange">;
  release(ownerId: string, sessionId: string): ReleaseResult;
  readonly logger: Pick<Logger, "warn">;
}): MemoryRelease {
  const watched = new Set<string>();
  const pending = new Map<string, string>();
  const attempt = (ownerId: string, sessionId: string): void => {
    const result = deps.release(ownerId, sessionId);
    if (result === "released") pending.delete(sessionId);
    else deps.logger.warn("memory_release_deferred", { sessionId, reason: result });
  };
  const unlisten = deps.policy.onSessionChange((ownerId, sessionId) => {
    if (!watched.has(sessionId) || !deps.policy.sessionPolicy(ownerId, sessionId).taint.tainted) return;
    watched.delete(sessionId);
    pending.set(sessionId, ownerId);
    attempt(ownerId, sessionId);
  });
  return {
    started(sessionId, decision) {
      pending.delete(sessionId);
      if ((decision.memory?.trust ?? "trusted") === "trusted") watched.add(sessionId);
      else watched.delete(sessionId);
    },
    ended(sessionId) {
      watched.delete(sessionId);
      pending.delete(sessionId);
    },
    reopened(sessionId) {
      const owner = pending.get(sessionId);
      if (owner !== undefined) attempt(owner, sessionId);
    },
    published(sessionId, event) {
      const owner = pending.get(sessionId);
      if (owner === undefined || event.kind !== "status" || event.status !== "idle") return;
      // The run's last bookkeeping follows the status event: look at the worker once it is done.
      queueMicrotask(() => {
        if (pending.has(sessionId)) attempt(owner, sessionId);
      });
    },
    renew(row, session, ensureLive) {
      if (!pending.has(row.id) || session.status() !== "idle" || session.busy()) return null;
      pending.delete(row.id);
      return session.stop().then(() => ensureLive(row));
    },
    stop: unlisten,
  };
}
