import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { countFire } from "./fire-counts.ts";
import { type FireVerdict, trimJournal, writeJournal } from "./fire-journal.ts";

/** Unauthenticated attempts of one trigger share a row for this long (M10R161). */
export const UNAUTHORIZED_WINDOW_MS = 600_000;

export interface HookTarget {
  readonly id: string;
  readonly ownerId: string;
}

export interface HookJournal {
  /** A request that did not authenticate. One row per trigger and window, counted; `mode` is the trigger's auth. */
  unauthorized(target: HookTarget, mode: "secret" | "hmac"): void;
  /** A refusal of an authenticated delivery; a repeat of the previous line adds to its count. */
  refused(
    target: HookTarget,
    verdict: Extract<FireVerdict, "bad_payload" | "throttle">,
    detail: string | null,
  ): void;
}

/**
 * The route's journal lines (the fire path writes its own). A line that cannot be written (the trigger was deleted
 * while the body streamed) is logged and dropped: the answer to the sender does not depend on it.
 */
export function createHookJournal(deps: { db: Db; clock: Clock; logger: Logger }): HookJournal {
  const { db, clock, logger } = deps;
  const guarded = (name: string, write: () => void): void => {
    try {
      db.transaction(write);
    } catch (error) {
      logger.warn(name, { err: error });
    }
  };
  return {
    unauthorized(target, mode) {
      let count = 0;
      countFire(db, "webhook", "unauthorized");
      guarded("hook_journal_failed", () => {
        const at = clock.now();
        const open = db.get<{ id: number; count: number }>(
          `SELECT id, count FROM trigger_fires
           WHERE trigger_id = $triggerId AND verdict = 'unauthorized' AND detail IS $mode AND first_at > $since
           ORDER BY id DESC LIMIT 1`,
          { triggerId: target.id, mode, since: at - UNAUTHORIZED_WINDOW_MS },
        );
        if (open) {
          count = open.count + 1;
          db.run("UPDATE trigger_fires SET count = $count, last_at = $at WHERE id = $id", {
            id: open.id,
            count,
            at,
          });
          return;
        }
        count = 1;
        db.run(
          `INSERT INTO trigger_fires (trigger_id, owner_id, source, verdict, detail, task_id, dedup_key, count, first_at, last_at)
           VALUES ($triggerId, $ownerId, 'webhook', 'unauthorized', $mode, NULL, NULL, 1, $at, $at)`,
          { triggerId: target.id, ownerId: target.ownerId, mode, at },
        );
        trimJournal(db, target.id, at);
      });
      if (count > 0) logger.warn("hook_unauthorized", { triggerId: target.id, count });
    },
    refused(target, verdict, detail) {
      guarded("hook_journal_failed", () =>
        writeJournal(db, {
          triggerId: target.id,
          ownerId: target.ownerId,
          source: "webhook",
          verdict,
          detail,
          taskId: null,
          dedupKey: null,
          at: clock.now(),
        }),
      );
    },
  };
}
