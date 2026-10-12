import type { Clock } from "../../kernel/clock.ts";
import { MAX_OUTSIDE_WRITES } from "./scan-port.ts";

/** A write counts as "outside pap" for this long (owner Q13, M4R141). */
export const OUTSIDE_WRITE_MS = 120_000;

/** What the service knows for the scan port's outside-write memory: its start, and when each worker last ended. */
export function createOutsideWrites(clock: Clock) {
  const startedAt = clock.now();
  // Bounded: the oldest end is dropped past MAX_OUTSIDE_WRITES; insertion order is age order.
  const ended = new Map<string, number>();
  return {
    startedAt,
    workerEndedAt: (sessionId: string): number | null => ended.get(sessionId) ?? null,
    workerEnded(sessionId: string): void {
      ended.delete(sessionId);
      ended.set(sessionId, clock.now());
      if (ended.size > MAX_OUTSIDE_WRITES) ended.delete(ended.keys().next().value as string);
    },
    /** Whether a write at `at` (null: none seen) is still recent at the daemon's clock. */
    recent: (at: number | null): boolean => at !== null && clock.now() - at <= OUTSIDE_WRITE_MS,
  };
}
