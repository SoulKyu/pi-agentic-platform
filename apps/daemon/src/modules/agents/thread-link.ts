import { PapError } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsAgentPort, SessionsModule } from "../sessions/index.ts";
import type { AgentLinks } from "./links.ts";

type Automation = Pick<
  SessionsModule["automation"],
  "state" | "promptPending" | "archive" | "onAttention" | "abort"
>;

export interface ThreadLinkDeps {
  readonly automation: Automation;
  readonly agentSessions: Pick<SessionsAgentPort, "applyLive">;
  readonly releaseIdle: SessionsModule["releaseIdle"];
  readonly runs: Pick<RunsPort, "onRunEnd">;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** A thread asked to be let go stays on the list this long between two asks, and for this many asks (M11R47). */
const RETRY_MS = 1000;
const RETRIES = 5;
/** Agents are capped at 32 and a reset leaves its old thread out of the list at once; this is only a hard bound. */
const WAITING_MAX = 64;

const gone = (error: unknown): boolean => error instanceof PapError && error.code === "not_found";

/**
 * The agents module's view of the thread's session. A thread whose row is gone is "not busy", and nothing to archive or
 * release (an agent whose thread was removed must still be deletable). An edit asks the worker to go (`releaseIdle`);
 * a busy answer is kept and asked again when the thread's run ends or its question is answered, so the edit really
 * applies when the agent goes idle, with `PAP_WORKER_IDLE_MINUTES=0` too (M11R47).
 */
export function createThreadLink(deps: ThreadLinkDeps) {
  const { automation, clock, logger } = deps;
  const waiting = new Map<string, { ownerId: string; timer: TimerHandle | null }>();

  function drop(sessionId: string): void {
    const entry = waiting.get(sessionId);
    if (entry?.timer) clock.clearTimeout(entry.timer);
    waiting.delete(sessionId);
  }

  /** Asks once; true while the worker is still there to be asked again. */
  function attempt(ownerId: string, sessionId: string): boolean {
    try {
      if (deps.releaseIdle(ownerId, sessionId) === "busy") return true;
    } catch (error) {
      if (!gone(error)) logger.warn("agent_release_failed", { err: error });
    }
    drop(sessionId);
    return false;
  }

  function retry(sessionId: string, tries: number): void {
    const entry = waiting.get(sessionId);
    if (!entry) return;
    if (entry.timer) clock.clearTimeout(entry.timer);
    if (!attempt(entry.ownerId, sessionId)) return;
    if (tries >= RETRIES) {
      entry.timer = null;
      return;
    }
    // The run's end is told before the worker says idle: the next ask is a moment later.
    entry.timer = clock.setTimeout(
      () => void guardTimer(logger, "agent_release_retry", () => retry(sessionId, tries + 1), clock),
      RETRY_MS,
    );
  }

  function ask(ownerId: string, sessionId: string): void {
    if (!attempt(ownerId, sessionId)) return;
    if (!waiting.has(sessionId) && waiting.size >= WAITING_MAX) {
      const oldest = waiting.keys().next().value;
      if (oldest !== undefined) drop(oldest);
    }
    waiting.set(sessionId, { ownerId, timer: waiting.get(sessionId)?.timer ?? null });
  }

  const stops = [
    deps.runs.onRunEnd((event) => retry(event.sessionId, 0)),
    automation.onAttention((sessionId, needsInput) => {
      if (!needsInput) retry(sessionId, 0);
    }),
  ];

  const link: NonNullable<AgentLinks["threads"]> = {
    busy(ownerId, sessionId) {
      try {
        return (
          (automation.state(ownerId, sessionId)?.running ?? false) ||
          automation.promptPending(ownerId, sessionId)
        );
      } catch (error) {
        if (gone(error)) return false;
        throw error;
      }
    },
    archive(ownerId, sessionId) {
      try {
        automation.archive(ownerId, sessionId);
      } catch (error) {
        if (!gone(error)) throw error;
      }
    },
    async abort(ownerId, sessionId) {
      try {
        await automation.abort(ownerId, sessionId);
      } catch (error) {
        if (!gone(error)) throw error;
      }
    },
    releaseIdle: ask,
    applyLive(ownerId, sessionId, change) {
      const { model, thinking } = change;
      deps.agentSessions
        .applyLive({
          ownerId,
          sessionId,
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
        })
        .catch((error: unknown) => {
          if (!gone(error)) logger.warn("agent_apply_live_failed", { err: error });
        });
    },
  };

  return {
    link,
    stop(): void {
      for (const stopListening of stops.splice(0)) stopListening();
      for (const sessionId of [...waiting.keys()]) drop(sessionId);
    },
  };
}
