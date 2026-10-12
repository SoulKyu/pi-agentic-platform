import type { Clock } from "../../kernel/clock.ts";

export interface BudgetedSession {
  readonly id: string;
  readonly ownerId: string;
}

interface Window {
  ownerId: string;
  startedAt: number;
  used: number;
  dropped: number;
}

/**
 * A per-session budget of worker rows per minute (M6): a worker that floods valid entries cannot fill an immutable
 * 12-month table. Rows past it are dropped and counted. The first drop of a window is reported at once, where the gap
 * begins (the caller writes the marker row there: a session that goes quiet still leaves its trace); the running count
 * is reported when the window ends or the session is forgotten. The map is bounded: past `maxSessions` the oldest
 * session is forgotten.
 */
export function createRowBudget(deps: {
  readonly clock: Clock;
  readonly perMinute: number;
  readonly maxSessions: number;
  /** The first drop of a window. */
  onFirstDrop(session: BudgetedSession): void;
  /** A window that dropped rows has ended (or its session was forgotten) with this many drops. */
  onWindowEnd(session: BudgetedSession, dropped: number): void;
}) {
  const windows = new Map<string, Window>();
  return {
    /** True when the row may be stored. */
    take(session: BudgetedSession): boolean {
      const now = deps.clock.now();
      let window = windows.get(session.id);
      if (!window) {
        if (windows.size >= deps.maxSessions) {
          const oldest = windows.entries().next();
          if (!oldest.done) {
            windows.delete(oldest.value[0]);
            if (oldest.value[1].dropped > 0)
              deps.onWindowEnd(
                { id: oldest.value[0], ownerId: oldest.value[1].ownerId },
                oldest.value[1].dropped,
              );
          }
        }
        window = { ownerId: session.ownerId, startedAt: now, used: 0, dropped: 0 };
        windows.set(session.id, window);
      } else if (now - window.startedAt >= 60_000) {
        if (window.dropped > 0) deps.onWindowEnd(session, window.dropped);
        window.startedAt = now;
        window.used = 0;
        window.dropped = 0;
      }
      if (window.used < deps.perMinute) {
        window.used++;
        return true;
      }
      window.dropped++;
      if (window.dropped === 1) deps.onFirstDrop(session);
      return false;
    },
  };
}
