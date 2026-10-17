import { type ParsedRrule, nextOccurrence, parseRrule, type TriggerInput } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { enqueueEffect, type Outbox } from "../../kernel/outbox/index.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import { createDueTimer } from "./due-timer.ts";
import type { FireInput, FireResult } from "./fire.ts";
import { writeJournal } from "./fire-journal.ts";
import type { PrecheckRunner } from "./precheck-step.ts";
import type { createTriggerStore } from "./store.ts";
import type { TaskStore } from "./tasks.ts";
import type { TriggerRecord } from "./triggers.ts";

/** An occurrence found later than this at run time is a missed fire, never a silent late one (M10R61, M10R62). */
export const LATE_MS = 120_000;
/** `catchUp: once` fires for a miss no older than this. */
export const CATCH_UP_MAX_MS = 12 * 3_600_000;
/** Occurrences counted in a `missed` line; a miss this long is far past the 12 hours anyway (the shortest rule is 5 minutes). */
const COUNT_CAP = 1000;
/** After a failed tick the earliest trigger is unknown: look again in a minute. */
const RETRY_MS = 60_000;

type ScheduleSource = Extract<TriggerInput["source"], { type: "schedule" }>;

export interface SchedulerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly triggers: { listEnabled(): TriggerRecord[] };
  readonly store: Pick<ReturnType<typeof createTriggerStore>, "setNextFire" | "clearDisabledNextFire">;
  /** The one fire path (M10R34). */
  fire(triggerId: string, revision: number, input: FireInput): FireResult;
  /** A database written by a newer pap: nothing is armed (M10R150). */
  readonly readOnly: boolean;
  /** The precheck before a fire (Task 9); none: a trigger's precheck is not run. */
  readonly precheck?: Pick<PrecheckRunner, "run">;
  /** Feed triggers are polled as `feed.poll` effects (M10R73); none: they are not scheduled. */
  readonly outbox?: Pick<Outbox, "poke">;
  /** Tasks that wait for a time (M11R81): with the outbox, the scheduler also arms a timer for the earliest of them. */
  readonly tasks?: Pick<TaskStore, "dueQueued" | "nextNotBefore">;
}

/**
 * The occurrences from `first` up to `now` (inclusive): the count stops at the cap, but `last` is always the real last
 * missed occurrence, found from the catch-up window when the cap was hit (never a stale 1000th).
 */
function missedBetween(rule: ParsedRrule, timeZone: string, first: number, now: number) {
  let count = 1;
  let last = first;
  for (;;) {
    const next = nextOccurrence(rule, timeZone, last);
    if (next === null || next > now) return { count, capped: false, last: last as number | null };
    if (count >= COUNT_CAP) break;
    count++;
    last = next;
  }
  // The shortest rule is 5 minutes apart, so the window holds at most about 150 occurrences.
  let inWindow: number | null = null;
  for (
    let next = nextOccurrence(rule, timeZone, now - CATCH_UP_MAX_MS - 1);
    next !== null && next <= now;
    next = nextOccurrence(rule, timeZone, next)
  )
    inWindow = next;
  return { count, capped: true, last: inWindow };
}

/**
 * The scheduler (M10R61): one guarded Clock timer for the earliest `next_fire_at` of the enabled schedule triggers.
 * A tick handles every trigger that is due. The next occurrence is stored before the fire, so a crash between the two
 * loses one fire and can never make a restart fire it twice.
 */
export function createScheduler(deps: SchedulerDeps) {
  const { clock, logger } = deps;
  let timer: TimerHandle | null = null;
  let running = false;
  const due =
    deps.tasks && deps.outbox
      ? createDueTimer({ db: deps.db, clock, logger, store: deps.tasks, outbox: deps.outbox })
      : null;

  function scheduleOf(record: TriggerRecord): { source: ScheduleSource; rule: ParsedRrule } | null {
    const source = record.input?.source;
    if (source?.type !== "schedule") return null;
    const parsed = parseRrule(source.rrule);
    return parsed.ok ? { source, rule: parsed.rule } : null;
  }

  function send(record: TriggerRecord, detail: string | null, precheck: string | null): void {
    deps.fire(record.id, record.revision, {
      ownerId: record.ownerId,
      source: "schedule",
      payload: null,
      precheck,
      dedupKey: null,
      title: record.name,
      detail,
      gated: true,
      gates: { exemptDisabled: false },
      retry: null,
    });
  }

  /** A trigger with a precheck fires once it answered (M10R68); the next occurrence is already stored, so a wait loses nothing. */
  function fireNow(record: TriggerRecord, detail: string | null): void {
    const { precheck } = deps;
    if (!precheck || record.input?.execution.precheck == null) return send(record, detail, null);
    precheck
      .run(record, { source: "schedule", gated: true, origin: "scheduler" })
      .then((step) => {
        // `stop()` aborted the precheck: the daemon is ending, nothing more is written.
        if (running && step.kind === "go") send(record, detail, step.precheck);
      })
      .catch((error: unknown) => logger.warn("scheduler_trigger_failed", { err: error }));
  }

  function handleDue(record: TriggerRecord, source: ScheduleSource, rule: ParsedRrule, due: number): void {
    const now = clock.now();
    deps.store.setNextFire(record.ownerId, record.id, nextOccurrence(rule, source.timezone, now));
    if (now - due <= LATE_MS) return fireNow(record, null);
    const missed = missedBetween(rule, source.timezone, due, now);
    if (source.catchUp === "once" && missed.last !== null && now - missed.last <= CATCH_UP_MAX_MS)
      return fireNow(record, "catch-up");
    writeJournal(deps.db, {
      triggerId: record.id,
      ownerId: record.ownerId,
      source: "schedule",
      verdict: "missed",
      detail: missed.capped ? `${missed.count}+` : String(missed.count),
      taskId: null,
      dedupKey: null,
      at: now,
    });
  }

  const feedOf = (record: TriggerRecord) =>
    deps.outbox && record.input?.source.type === "feed" ? record.input.source : null;

  /**
   * A feed trigger that is due is polled by an effect with the receipt `feed:<trigger>:<due time>`, and its next poll is
   * stored in the same transaction: a restart never polls an occurrence twice, and a long stop polls once, not once per miss.
   */
  function pollFeed(record: TriggerRecord, everyMinutes: number): void {
    const now = clock.now();
    if (record.nextFireAt !== null && record.nextFireAt > now) return;
    deps.db.transaction(() => {
      deps.store.setNextFire(record.ownerId, record.id, now + everyMinutes * 60_000);
      enqueueEffect(
        deps.db,
        {
          kind: "feed.poll",
          ownerId: record.ownerId,
          payload: { triggerId: record.id },
          dedupKey: `feed:${record.id}:${record.nextFireAt ?? now}`,
        },
        now,
      );
    });
    deps.outbox?.poke();
  }

  function sweep(): void {
    deps.store.clearDisabledNextFire();
    for (const record of deps.triggers.listEnabled()) {
      const feed = feedOf(record);
      if (feed !== null) {
        try {
          pollFeed(record, feed.everyMinutes);
        } catch (error) {
          logger.warn("scheduler_trigger_failed", { err: error });
        }
        continue;
      }
      const schedule = scheduleOf(record);
      if (schedule === null) continue;
      try {
        const now = clock.now();
        if (record.nextFireAt === null) {
          const next = nextOccurrence(schedule.rule, schedule.source.timezone, now);
          deps.store.setNextFire(record.ownerId, record.id, next);
        } else if (record.nextFireAt <= now) {
          handleDue(record, schedule.source, schedule.rule, record.nextFireAt);
        }
      } catch (error) {
        logger.warn("scheduler_trigger_failed", { err: error });
      }
    }
  }

  function earliest(): number | null {
    let first: number | null = null;
    for (const record of deps.triggers.listEnabled())
      if ((scheduleOf(record) !== null || feedOf(record) !== null) && record.nextFireAt !== null)
        first = first === null ? record.nextFireAt : Math.min(first, record.nextFireAt);
    return first;
  }

  function disarm(): void {
    if (timer) clock.clearTimeout(timer);
    timer = null;
  }

  function arm(): void {
    disarm();
    let delay: number | null;
    try {
      const first = earliest();
      // A trigger still due after a pass failed it: wait rather than spin on it.
      delay = first === null ? null : first <= clock.now() ? RETRY_MS : first - clock.now();
    } catch (error) {
      logger.warn("scheduler_arm_failed", { err: error });
      delay = RETRY_MS;
    }
    if (delay === null) return;
    timer = clock.setTimeout(() => {
      timer = null;
      run();
    }, delay);
  }

  /** One pass, then the next timer. `guardTimer` runs the body at once, so the timer is re-armed after the pass. */
  function run(): void {
    if (!running) return;
    void guardTimer(logger, "scheduler", sweep, clock);
    arm();
  }

  return {
    /** After the server listens: a trigger overdue from the last life is handled now (M10R62). */
    start(): void {
      if (deps.readOnly || running) return;
      running = true;
      run();
      due?.start();
    },
    /** A task that waits for a time was made (M11R81): its time may be the earliest now. */
    armDue(): void {
      due?.refresh();
    },
    /** A trigger was saved, switched or deleted: its next occurrence is recomputed from now (M10R61). */
    refresh(): void {
      run();
    },
    stop(): void {
      running = false;
      disarm();
      due?.stop();
    },
  };
}
export type Scheduler = ReturnType<typeof createScheduler>;
