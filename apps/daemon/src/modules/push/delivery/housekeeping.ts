import type { Clock, TimerHandle } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import type { Logger } from "../../../kernel/logger.ts";
import { guardTimer } from "../../../kernel/timer-guard.ts";

const HOUR_MS = 3_600_000;
const KEEP_MS = 14 * 86_400_000;

/**
 * The 14-day purge (M12R17): settled events and their deliveries go, `pending` and `held` events never. Also gone, at
 * any age: the pending deliveries a cancelled event left behind (it will not send them) and deliveries of no event.
 * Returns the number of events removed.
 */
export function purgePush(db: Db, now: number): number {
  return db.transaction(() => {
    const before = now - KEEP_MS;
    const old = `SELECT id FROM push_events WHERE state NOT IN ('pending', 'held') AND COALESCE(settled_at, created_at) < $before`;
    db.run(
      `DELETE FROM push_deliveries WHERE event_id IN (${old})
         OR event_id NOT IN (SELECT id FROM push_events)
         OR (state = 'pending' AND event_id IN (SELECT id FROM push_events WHERE state = 'cancelled'))`,
      { before },
    );
    db.run(`DELETE FROM push_meta WHERE key LIKE 'digest:%' AND substr(key, 8) IN (${old})`, { before });
    return db.run(`DELETE FROM push_events WHERE id IN (${old})`, { before }).changes;
  });
}

/** One guarded Clock timer each hour, none on a read-only database (the shape of the automation housekeeping). */
export function createPushHousekeeping(deps: {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
}) {
  let timer: TimerHandle | null = null;
  let stopped = false;
  const pass = (): void => {
    const removed = purgePush(deps.db, deps.clock.now());
    if (removed > 0) deps.logger.info("push_events_purged", { removed });
  };
  const arm = (): void => {
    timer = deps.clock.setTimeout(() => {
      timer = null;
      void guardTimer(deps.logger, "push_housekeeping", pass, deps.clock).finally(() => {
        if (!stopped) arm();
      });
    }, HOUR_MS);
  };
  return {
    start(): void {
      if (deps.readOnly || timer !== null) return;
      stopped = false;
      arm();
    },
    stop(): void {
      stopped = true;
      if (timer) deps.clock.clearTimeout(timer);
      timer = null;
    },
  };
}
