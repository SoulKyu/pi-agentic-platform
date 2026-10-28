import type { SessionCost } from "@pap/contracts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { RunsService } from "./modules/runs/index.ts";

/** A figure the wire accepts: finite, not negative, at most the contract's cap. */
const usd = (value: number): number => (Number.isFinite(value) ? Math.min(1e9, Math.max(0, value)) : 0);

/**
 * UX-1 §4.4 (UX1-R7): the session's cost reaches its stream. The runs registry says when it changes (a live cost, a run
 * start or end; a child's start and end also refresh its parent) and the sessions module publishes it, read at that
 * moment. Returns what undoes the listeners.
 */
export function composeSessionCost(
  runs: Pick<RunsService, "port" | "peek">,
  sessions: Pick<SessionsModule, "cost">,
): () => void {
  const { port } = runs;
  sessions.cost.bind({
    costOf(sessionId): SessionCost | null {
      const session = port.sessionCost(sessionId);
      if (session === null) return null;
      const run = runs.peek(sessionId);
      return {
        sessionUsd: usd(session),
        runUsd: run ? usd(run.costUsd) : null,
        billing: port.sessionBilling(sessionId) ?? "unknown",
      };
    },
  });
  const stops = [
    port.onLiveCost((sessionId) => sessions.cost.changed(sessionId)),
    port.onRunStart((event) => sessions.cost.changed(event.sessionId, { parent: true })),
    port.onRunEnd((event) => sessions.cost.changed(event.sessionId, { parent: true })),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
