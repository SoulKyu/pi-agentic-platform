import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { enqueueEffect, type Outbox } from "../../kernel/outbox/index.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import type { TaskStore } from "./tasks.ts";

/** Tasks released in one pass; a bigger backlog goes on the next pass. */
const BATCH = 100;
/** After a failed pass the earliest time is unknown: look again in a minute. */
const RETRY_MS = 60_000;

export interface DueTimerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: Pick<TaskStore, "dueQueued" | "nextNotBefore">;
  readonly outbox: Pick<Outbox, "poke">;
}

/**
 * M11R81: one guarded Clock timer for the earliest `not_before` among queued tasks, beside the scheduler's trigger timer.
 * A task that waits for a time has no `task.start` effect (the admission skips it meanwhile); when its time comes this
 * sends one, once (the receipt names the task). A pass also sends the effects of tasks already due, so a task whose time
 * came while the daemon was down starts after the boot, and one that cannot start yet is not sent again.
 */
export function createDueTimer(deps: DueTimerDeps) {
  const { clock, logger } = deps;
  let timer: TimerHandle | null = null;
  let running = false;

  function release(): void {
    const now = clock.now();
    const due = deps.store.dueQueued(now, BATCH);
    for (const task of due)
      enqueueEffect(
        deps.db,
        {
          kind: "task.start",
          ownerId: task.owner_id,
          payload: { taskId: task.id },
          dedupKey: `due:${task.id}`,
        },
        now,
      );
    if (due.length > 0) deps.outbox.poke();
  }

  function disarm(): void {
    if (timer) clock.clearTimeout(timer);
    timer = null;
  }

  /** One pass, then the timer for the next time ahead. */
  function arm(): void {
    disarm();
    if (!running) return;
    void guardTimer(logger, "due_tasks", release, clock);
    let delay: number;
    try {
      const next = deps.store.nextNotBefore(clock.now());
      if (next === null) return;
      delay = Math.max(0, next - clock.now());
    } catch (error) {
      logger.warn("due_tasks_arm_failed", { err: error });
      delay = RETRY_MS;
    }
    timer = clock.setTimeout(arm, delay);
  }

  return {
    /** After the server listens (not in read-only mode, where nothing is armed). */
    start(): void {
      running = true;
      arm();
    },
    /** A task that waits for a time was made, or one changed: look again. */
    refresh(): void {
      arm();
    },
    stop(): void {
      running = false;
      disarm();
    },
  };
}
