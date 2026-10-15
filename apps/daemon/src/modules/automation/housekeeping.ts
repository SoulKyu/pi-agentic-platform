import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { Logger } from "../../kernel/logger.ts";
import { enqueueEffect, type Outbox } from "../../kernel/outbox/index.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { trimJournals } from "./fire-journal.ts";
import type { TaskStore } from "./tasks.ts";

const HOUR_MS = 3_600_000;
const TASK_KEEP_MS = 30 * 86_400_000;
/** A session touched later than this after its task ended was reopened by the owner (M10R155). */
const REOPENED_AFTER_MS = 60_000;
/** Sessions deleted a pass: a backlog drains over the next passes. */
const SESSIONS_PER_PASS = 100;

export interface HousekeepingDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: Pick<TaskStore, "doneWithSessionBefore" | "remove" | "removeEndedBefore">;
  readonly outbox: Pick<Outbox, "purge" | "poke" | "db">;
  readonly sessions: Pick<SessionsAutomationPort, "state" | "lastActivityAt" | "deleteTaskSession">;
  /** Task 6's Inbox retention; none until the Inbox exists. */
  readonly inboxRetention?: () => void;
  /** The automation time zone, which names the day of the attachment cleanup. */
  readonly timeZone: () => string | null;
  readonly readOnly: boolean;
}

/** The housekeeping of the automation module (M10R44): one guarded Clock timer each hour, none in read-only mode. */
export function createHousekeeping(deps: HousekeepingDeps) {
  const { clock, logger, store, sessions } = deps;
  let timer: TimerHandle | null = null;
  let stopped = false;

  /** A failing step is said once a minute and never stops the next one. */
  const step = (name: string, work: () => void): void => {
    try {
      work();
    } catch (error) {
      logger.warn(`housekeeping_${name}_failed`, { err: error });
    }
  };

  /** The session of a done task goes when nobody went back to it; true when the task row can go too. */
  function sessionGone(task: {
    owner_id: string;
    session_id: string | null;
    ended_at: number | null;
  }): boolean {
    const sessionId = task.session_id as string;
    const state = sessions.state(task.owner_id, sessionId);
    if (state === null) return true;
    const activity = sessions.lastActivityAt(sessionId);
    const reopened = activity === null || activity > (task.ended_at as number) + REOPENED_AFTER_MS;
    // The owner archived it again or went back to it: it is a session of their own now, and the task row goes alone.
    if (!state.archived || reopened) return true;
    return sessions.deleteTaskSession(task.owner_id, sessionId) !== "busy";
  }

  function pass(): void {
    if (deps.readOnly) return;
    const now = clock.now();
    step("outbox_purge", () => void deps.outbox.purge());
    step("sessions", () => {
      for (const task of store.doneWithSessionBefore(now - TASK_KEEP_MS, SESSIONS_PER_PASS))
        if (sessionGone(task)) store.remove(task.id);
    });
    step("tasks", () => void store.removeEndedBefore(now - TASK_KEEP_MS));
    step("journal", () => void trimJournals(deps.db, now));
    step("inbox", () => deps.inboxRetention?.());
    step("attachments", () => {
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: deps.timeZone() ?? undefined,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
      const id = enqueueEffect(
        deps.outbox.db,
        { kind: "attachment.cleanup", ownerId: null, payload: { day }, dedupKey: `attachments:${day}` },
        now,
      );
      if (id !== null) deps.outbox.poke();
    });
  }

  function arm(delay: number): void {
    timer = clock.setTimeout(() => {
      timer = null;
      void guardTimer(logger, "housekeeping", pass, clock).finally(() => {
        if (!stopped) arm(HOUR_MS);
      });
    }, delay);
  }

  return {
    pass,
    start(): void {
      if (deps.readOnly || timer !== null) return;
      stopped = false;
      arm(HOUR_MS);
    },
    stop(): void {
      stopped = true;
      if (timer) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
