import type { SessionStreamEvent } from "@pap/contracts";
import { within } from "../../kernel/fs/boundary.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionRow } from "./store.ts";

/**
 * A trust decision applies at the next open of a worker (M7R105): the workers of the owner in the folder or below are
 * let go so that the next prompt opens one that reads the new decision. An idle one goes at once; one that is working,
 * or still starting, goes when its run is over. The session stays: it goes cold and comes back with its next prompt.
 */
export function createFolderRestart(deps: {
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly reopening: ReadonlyMap<string, unknown>;
  readonly row: (sessionId: string) => SessionRow | undefined;
  readonly logger: Logger;
}) {
  // `needsRun`: the worker was still starting when the decision landed. It was started for a prompt that is about to be
  // sent, so it is released after that run, never when it comes up (the prompt would fail with `worker_failed`).
  const waiting = new Map<string, { needsRun: boolean }>();

  function releaseIfDue(sessionId: string): void {
    const session = deps.live.get(sessionId);
    if (!session) return;
    if (session.stopping()) {
      waiting.delete(sessionId);
      return;
    }
    if (session.status() !== "idle" || session.busy()) return;
    waiting.delete(sessionId);
    session.stop().catch((error: unknown) => deps.logger.warn("worker_stop_failed", { err: error }));
  }

  return {
    /** Returns how many workers are released or will be: the ones the decision concerns. */
    restart(ownerId: string, folder: string): number {
      let concerned = 0;
      for (const sessionId of new Set([...deps.live.keys(), ...deps.reopening.keys()])) {
        const row = deps.row(sessionId);
        if (!row || row.ownerId !== ownerId || !within(folder, row.cwd)) continue;
        concerned += 1;
        // A second decision keeps a pending first run: the worker that just came up has not had it yet.
        const needsRun = waiting.get(sessionId)?.needsRun === true || !deps.live.has(sessionId);
        waiting.set(sessionId, { needsRun });
        if (!needsRun) releaseIfDue(sessionId);
      }
      return concerned;
    },
    /** A run ended (the status says `idle`), or the worker is gone: the session's turn has come, or its wait is over. */
    published(sessionId: string, event: SessionStreamEvent): void {
      if (!waiting.has(sessionId) || event.kind !== "status") return;
      const entry = waiting.get(sessionId);
      if (event.status === "cold") waiting.delete(sessionId);
      else if (event.status === "running" && entry) entry.needsRun = false;
      else if (event.status === "idle" && entry?.needsRun) return;
      // The run's last bookkeeping follows the status event: look at the worker once it is done.
      else if (event.status === "idle") queueMicrotask(() => releaseIfDue(sessionId));
    },
    /** A worker came up after a reopen: a waiting one that has had its run is released; one that has not waits for it. */
    reopened(sessionId: string): void {
      if (waiting.get(sessionId)?.needsRun === false) releaseIfDue(sessionId);
    },
  };
}
