import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Outbox } from "../../kernel/outbox/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";

/** How long a Cancel waits for the continuation it could not stop to start: longer than a cold reopen takes (15 s at most). */
export const ABORT_NEXT_MS = 60_000;

/**
 * M10R105: Cancel against a resume already past its sent mark while its worker reopens. `sessions.abort` does nothing
 * then (the session is not live), and the continuation would run as the owner's own, outside every cap. So the session
 * is remembered, and the first run to start in it is aborted. One shot: the flag goes with that run start, or after
 * `ABORT_NEXT_MS`, whichever comes first, so it never reaches a later owner prompt.
 */
export function createAbortNext(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sessions: Pick<SessionsAutomationPort, "abort" | "state">;
  /** The resume's continuation for the session is on its way (from its sent mark). */
  sending(sessionId: string): boolean;
  readonly outbox: Pick<Outbox, "cancel" | "view">;
}) {
  const armed = new Map<string, { ownerId: string; timer: TimerHandle }>();

  function disarm(sessionId: string): { ownerId: string } | undefined {
    const entry = armed.get(sessionId);
    if (!entry) return undefined;
    deps.clock.clearTimeout(entry.timer);
    armed.delete(sessionId);
    return entry;
  }

  return {
    /** Retires the pending resumes (inside Cancel's transaction); true when one was already sent and cannot be recalled. */
    retire(keys: readonly string[]): boolean {
      let sending = false;
      for (const key of keys) {
        const sent = deps.outbox.view(key)?.sent === true;
        if (deps.outbox.cancel(key) === "marked" && sent) sending = true;
      }
      return sending;
    },
    /** Only a worker that is reopening needs it: a live one is stopped by `abort` itself. */
    armIfReopening(ownerId: string, sessionId: string): void {
      if (deps.sessions.state(ownerId, sessionId)?.running === true) return;
      if (!deps.sending(sessionId)) return;
      disarm(sessionId);
      const timer = deps.clock.setTimeout(() => void armed.delete(sessionId), ABORT_NEXT_MS);
      armed.set(sessionId, { ownerId, timer });
    },
    /** The continuation ended without a run (a launch error, a refusal): nothing is left to abort. */
    disarm(sessionId: string): void {
      disarm(sessionId);
    },
    /** A run started in the session: aborts it when a Cancel armed the session. */
    runStarted(sessionId: string): void {
      const entry = disarm(sessionId);
      if (!entry) return;
      deps.sessions.abort(entry.ownerId, sessionId).catch((error: unknown) => {
        deps.logger.warn("task_cancelled_resume_abort_failed", { sessionId, err: error });
      });
    },
    stop(): void {
      for (const sessionId of [...armed.keys()]) disarm(sessionId);
    },
  };
}
