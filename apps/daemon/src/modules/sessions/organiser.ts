import type { Marks } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import type { MarksStore } from "./marks-store.ts";
import type { ShellPublisher } from "./shell-publisher.ts";

export const AUTO_SETTLE_AFTER_MS = 3 * 86_400_000;
export const SWEEP_EVERY_MS = 3_600_000;
export const SWEEP_BATCH = 500;
/** A wake that failed tries again after this. */
export const RETRY_MS = 60_000;

export interface Organiser {
  start(): void;
  stop(): void;
  /** A snooze changed: the wake timer follows the earliest one. */
  rearm(): void;
  /** Someone worked in the session: it is no longer settled or snoozed (M4R41). Never throws. */
  activity(sessionId: string): void;
}

export function createOrganiser(deps: {
  readonly store: MarksStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publisher: ShellPublisher;
  isLive(sessionId: string): boolean;
  /** A database a newer pap wrote: nothing is armed and nothing written (M4R43). */
  readonly readOnly: boolean;
}): Organiser {
  let sweepTimer: TimerHandle | null = null;
  let wakeTimer: TimerHandle | null = null;
  let stopped = true;
  const limiter = createRateLimiter(deps.clock, 60_000);

  // A SQLite error inside a timer callback would be an uncaught exception: it is said, at most once a minute per kind,
  // and the caller re-arms (M4R42). `undefined` means it failed.
  const attempt = <T>(event: string, run: () => T): T | undefined => {
    try {
      return run();
    } catch (error) {
      const said = limiter.check(event);
      if (said.allowed) deps.logger.error(event, { err: error, suppressed: said.suppressed });
      return undefined;
    }
  };

  const update = (id: string, change: Partial<Marks>) => {
    const row = deps.store.row(id);
    if (!row) return;
    deps.store.write(id, { ...row.marks, ...change }, null);
    deps.publisher.changed(id);
  };

  function sweep(): void {
    sweepTimer = null;
    if (stopped) return;
    const more = attempt("sessions_sweep_failed", () => {
      const now = deps.clock.now();
      // Live sessions (at most the worker cap) are skipped here, not in SQL.
      const candidates = deps.store.settleCandidates(now - AUTO_SETTLE_AFTER_MS, SWEEP_BATCH);
      let settled = 0;
      for (const id of candidates) {
        if (deps.isLive(id)) continue;
        update(id, { settledAt: now, settledAuto: true });
        settled++;
      }
      if (settled > 0) deps.logger.info("sessions_auto_settled", { count: settled });
      // Only a full batch that made progress asks for a next turn: a batch of live sessions would come back unchanged.
      return settled > 0 && candidates.length === SWEEP_BATCH;
    });
    // A full batch: the rest go on the next turn of the loop, not in this one (M4R40).
    sweepTimer = deps.clock.setTimeout(sweep, more === true ? 0 : SWEEP_EVERY_MS);
  }

  function wake(): void {
    wakeTimer = null;
    if (stopped) return;
    const done = attempt("sessions_wake_failed", () => {
      for (const id of deps.store.dueSnoozes(deps.clock.now(), SWEEP_BATCH))
        update(id, { snoozedUntil: null });
      return true;
    });
    if (done) rearm();
    else wakeTimer = deps.clock.setTimeout(wake, RETRY_MS);
  }

  function rearm(): void {
    if (wakeTimer) deps.clock.clearTimeout(wakeTimer);
    wakeTimer = null;
    if (stopped) return;
    const next = attempt("sessions_wake_failed", () => deps.store.nextSnooze());
    // Unreadable: try again later rather than never wake.
    if (next === undefined) wakeTimer = deps.clock.setTimeout(wake, RETRY_MS);
    else if (next !== null) wakeTimer = deps.clock.setTimeout(wake, Math.max(0, next - deps.clock.now()));
  }

  return {
    start() {
      if (deps.readOnly) return;
      stopped = false;
      sweep();
      rearm();
    },
    stop() {
      stopped = true;
      if (sweepTimer) deps.clock.clearTimeout(sweepTimer);
      if (wakeTimer) deps.clock.clearTimeout(wakeTimer);
      sweepTimer = null;
      wakeTimer = null;
    },
    rearm,
    activity(sessionId) {
      if (deps.readOnly) return;
      attempt("sessions_activity_failed", () => {
        const row = deps.store.row(sessionId);
        if (!row || (row.marks.settledAt === null && row.marks.snoozedUntil === null)) return;
        const wasSnoozed = row.marks.snoozedUntil !== null;
        update(sessionId, { settledAt: null, settledAuto: false, snoozedUntil: null });
        if (wasSnoozed) rearm();
      });
    },
  };
}
