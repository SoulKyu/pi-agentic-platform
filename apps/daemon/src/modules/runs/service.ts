import { USAGE_TOP_MODELS, type UsageRange, type UsageSummary } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { scrubKnownSecrets } from "../audit/index.ts";
import { rangeStart, serverTimeZone, startOfLocalDay } from "./days.ts";
import {
  createRunTracker,
  type OpenRunView,
  type RunEndEvent,
  type RunObserver,
  type RunStartEvent,
} from "./observer.ts";
import type { RunRow, RunsStore } from "./store.ts";

export type { OpenRunView, RunEndEvent, RunObserver, RunStartEvent } from "./observer.ts";

type Unsubscribe = () => void;

/** What the other modules see of the registry (M10R89). Listeners are isolated: one that throws is logged. */
export interface RunsPort {
  onRunStart(listener: (event: RunStartEvent) => void): Unsubscribe;
  onRunEnd(listener: (event: RunEndEvent) => void): Unsubscribe;
  /** The task whose run the session is in now; null when it has no open run or the open run is not a task's (a child's tag, Task 29b). */
  openTaskOf(sessionId: string): string | null;
  /** The origin and task the next run of the session gets, if it starts within 5 minutes. False: the table is full (64). */
  expectOrigin(sessionId: string, expectation: { origin: string; taskId: string | null }): boolean;
  clearExpected(sessionId: string): void;
  /** Tags the session's open run, so that an abort the runner makes is not read as a person's Stop (M10R156). */
  markEnding(sessionId: string, errorClass: "deadline" | "run_budget" | "budget"): void;
  /** After each assistant message and compaction: the run's cost so far. */
  onLiveCost(listener: (sessionId: string, ownerId: string, runCostUsd: number) => void): Unsubscribe;
  /** Today's cost of the automation's runs (a task's, and every resume), the runs in flight included. */
  spentToday(ownerId: string, timeZone: string | null): number;
  /** The same, for the runs of the given tasks only (a trigger's own budget). */
  spentTodayOf(ownerId: string, timeZone: string | null, taskIds: readonly string[]): number;
  /** What the task's runs ended since `since` cost, its runs in flight included: a task's own session and its subagents' (M11R141). */
  spentByTask(ownerId: string, taskId: string, since: number): number;
  /** Everything the session's runs cost, the open run included; null when it has had none (agreement 14). */
  sessionCost(sessionId: string): number | null;
  /** How the session's runs are billed (agreement 14's "API-equivalent" label); `unknown` while only an open run exists, null with none. */
  sessionBilling(sessionId: string): "api" | "subscription" | "unknown" | null;
  /** When the quota of the session's newest run resets, if that run ended `limited`; null once it runs again. */
  limitResetAt(sessionId: string): number | null;
  onResumeSkipped(listener: (sessionId: string, reason: string) => void): Unsubscribe;
  summary(ownerId: string, range: UsageRange, timeZone: string | null): UsageSummary;
}

export interface RunsService {
  readonly port: RunsPort;
  readonly observer: RunObserver;
  /** A run in flight as the observer holds it, error text included (Task 17 reads it when the run ends). */
  peek(sessionId: string): OpenRunView | null;
  /** A resume was not started (`archived`, `newer_input`, `full_access`, `budget`, `child`): the runner of a task hears of it. */
  resumeSkipped(sessionId: string, reason: string): void;
  /**
   * Called inside the transaction that closes a run as `limited` (M10R104); one hook, set once at composition. It
   * writes the resume effect, so the run and its resume commit together. A throw is logged and the run stays closed.
   */
  onLimited(hook: (event: RunEndEvent, row: RunRow) => void): void;
  /** What the limit screens and the resume read: the run rows, never the tracker's memory. */
  readonly lookup: Pick<RunsStore, "get" | "latestOf" | "latestBefore" | "newerThan" | "limitedSessions">;
  /** At boot: every run a crash left running becomes interrupted, with its line. Returns how many. */
  recover(): number;
}

const LOG_EVERY_MS = 60_000;

/** The two facts Settings › Automation shows about the exports; the token and the headers never get here (M10R121). */
export interface ObservabilityFacts {
  readonly metrics: boolean;
  readonly otlpHost: string | null;
}
const NO_EXPORTS: ObservabilityFacts = { metrics: false, otlpHost: null };

export function createRunsService(deps: {
  readonly store: RunsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly newId: () => string;
  /** Writes the ended run to `logs/runs.jsonl`; may throw, the run is already stored. */
  readonly exportRun: (row: RunRow) => void;
  readonly observability?: ObservabilityFacts;
}): RunsService {
  const { store, clock } = deps;
  const observability = deps.observability ?? NO_EXPORTS;
  const logger = deps.logger.child({ component: "runs" });
  const limiter = createRateLimiter(clock, LOG_EVERY_MS);
  const said = (name: string, error: unknown): void => {
    const verdict = limiter.check(name);
    if (verdict.allowed)
      logger.warn(name, {
        err: String((error as { message?: unknown }).message ?? error).slice(0, 200),
        suppressed: verdict.suppressed,
      });
  };

  function listeners<Args extends unknown[]>() {
    const held = new Set<(...args: Args) => void>();
    return {
      add(listener: (...args: Args) => void): Unsubscribe {
        held.add(listener);
        return () => void held.delete(listener);
      },
      emit(...args: Args): void {
        for (const listener of [...held]) {
          try {
            listener(...args);
          } catch (error) {
            said("runs_listener_failed", error);
          }
        }
      },
    };
  }
  const started = listeners<[RunStartEvent]>();
  const ended = listeners<[RunEndEvent]>();
  const live = listeners<[string, string, number]>();
  const skipped = listeners<[string, string]>();

  function exportRun(row: RunRow): void {
    try {
      deps.exportRun(row);
    } catch (error) {
      said("runs_export_failed", error);
    }
  }

  let limitedHook: ((event: RunEndEvent, row: RunRow) => void) | null = null;
  const tracker = createRunTracker({
    store,
    clock,
    logger: deps.logger,
    newId: deps.newId,
    scrub: scrubKnownSecrets,
    hooks: {
      started: started.emit,
      limited: (event, row) => limitedHook?.(event, row),
      ended(event, row) {
        exportRun(row);
        ended.emit(event);
      },
      live: live.emit,
    },
  });

  const sinceMidnight = (timeZone: string | null): number => startOfLocalDay(clock.now(), timeZone);

  const port: RunsPort = {
    onRunStart: started.add,
    onRunEnd: ended.add,
    openTaskOf: (sessionId) => tracker.peek(sessionId)?.taskId ?? null,
    expectOrigin: tracker.expectOrigin,
    clearExpected: tracker.clearExpected,
    markEnding: tracker.markEnding,
    onLiveCost: live.add,
    spentToday: (ownerId, timeZone) =>
      store.spentSince(ownerId, sinceMidnight(timeZone), null) + tracker.liveSpent(ownerId, null),
    spentTodayOf: (ownerId, timeZone, taskIds) =>
      store.spentSince(ownerId, sinceMidnight(timeZone), taskIds) + tracker.liveSpent(ownerId, taskIds),
    spentByTask: (ownerId, taskId, since) =>
      store.spentSince(ownerId, since, [taskId]) + tracker.liveSpent(ownerId, [taskId]),
    sessionCost(sessionId) {
      const finished = store.sessionTotals(sessionId);
      const open = tracker.liveCost(sessionId);
      return finished.runs === 0 && open === null ? null : finished.costUsd + (open ?? 0);
    },
    sessionBilling(sessionId) {
      return store.sessionBilling(sessionId) ?? (tracker.liveCost(sessionId) === null ? null : "unknown");
    },
    limitResetAt(sessionId) {
      const newest = store.latestOf(sessionId);
      return newest?.status === "limited" ? newest.limitResetAt : null;
    },
    onResumeSkipped: skipped.add,
    summary(ownerId, range, timeZone) {
      const now = clock.now();
      const from = rangeStart(now, range, timeZone);
      const byModel = store.byModel(ownerId, from, now);
      const rest = byModel.slice(USAGE_TOP_MODELS);
      return {
        from,
        to: now,
        timeZone: timeZone ?? serverTimeZone(),
        totals: store.totals(ownerId, from, now),
        byOrigin: store.byOrigin(ownerId, from, now),
        byModel: [
          ...byModel.slice(0, USAGE_TOP_MODELS),
          ...(rest.length === 0
            ? []
            : [
                {
                  provider: "other",
                  model: "other",
                  billing: "unknown" as const,
                  costUsd: rest.reduce((sum, bucket) => sum + bucket.costUsd, 0),
                  tokens: rest.reduce((sum, bucket) => sum + bucket.tokens, 0),
                  runs: rest.reduce((sum, bucket) => sum + bucket.runs, 0),
                },
              ]),
        ],
        metrics: observability.metrics,
        otlpHost: observability.otlpHost,
      };
    },
  };

  return {
    port,
    observer: tracker,
    peek: tracker.peek,
    resumeSkipped: skipped.emit,
    onLimited(hook) {
      limitedHook = hook;
    },
    lookup: store,
    recover() {
      let recovered = 0;
      for (const row of store.running()) {
        const closed = tracker.closeAsCrash(row);
        if (!closed) continue;
        recovered += 1;
        exportRun(closed);
      }
      return recovered;
    },
  };
}
