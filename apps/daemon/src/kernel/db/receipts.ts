import type { Clock, TimerHandle } from "../clock.ts";
import type { Logger } from "../logger.ts";
import type { Db } from "./database.ts";

export interface ReceiptStore {
  find(userId: string, commandId: string): { method: string; result: unknown } | null;
  save(userId: string, commandId: string, method: string, result: unknown): void;
  /** Deletes receipts older than the retention window (spec C 3.4) and returns how many went. */
  purge(): number;
  /** True when the database was written by a newer version: saving a receipt, or any mutation, cannot succeed. */
  readonly readOnly: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 7 * DAY_MS;
const PURGE_INTERVAL_MS = DAY_MS;

export function createReceiptStore(db: Db, clock: Clock): ReceiptStore {
  return {
    readOnly: db.readOnly,
    find(userId, commandId) {
      const row = db.get<{ method: string; result: string }>(
        "SELECT method, result FROM receipts WHERE user_id = $userId AND command_id = $commandId",
        { userId, commandId },
      );
      return row ? { method: row.method, result: JSON.parse(row.result) as unknown } : null;
    },
    save(userId, commandId, method, result) {
      db.run(
        "INSERT OR IGNORE INTO receipts (user_id, command_id, method, result, created_at) VALUES ($userId, $commandId, $method, $result, $at)",
        { userId, commandId, method, result: JSON.stringify(result ?? null), at: clock.now() },
      );
    },
    purge() {
      if (db.readOnly) return 0;
      return db.run("DELETE FROM receipts WHERE created_at < $cutoff", { cutoff: clock.now() - RETENTION_MS })
        .changes;
    },
  };
}

/** Purges now, then every 24 h on the injected clock. A failing purge is logged and retried at the next tick. */
export function startReceiptPurge(store: ReceiptStore, clock: Clock, logger: Logger): { stop(): void } {
  let timer: TimerHandle | null = null;
  let stopped = false;
  const tick = (): void => {
    try {
      const removed = store.purge();
      if (removed > 0) logger.info("receipts_purged", { removed });
    } catch (error) {
      logger.warn("receipts_purge_failed", { error });
    }
    if (!stopped) timer = clock.setTimeout(tick, PURGE_INTERVAL_MS);
  };
  tick();
  return {
    stop() {
      stopped = true;
      if (timer) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
