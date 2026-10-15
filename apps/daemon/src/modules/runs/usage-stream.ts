import type { AutomationSettings, LimitView } from "@pap/contracts";
import { USAGE_MAX_LIMITS } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Outbox } from "../../kernel/outbox/index.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { resumeKey } from "./resume.ts";
import type { RunsPort, RunsService } from "./service.ts";
import type { RunRow } from "./store.ts";

/** `spend` reaches a screen at most this often; the last value always follows (M10R107). */
const SPEND_EVERY_MS = 5_000;

export interface UsageStreamDeps {
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot" | "hasSubscribers">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runs: Pick<RunsService, "lookup">;
  readonly port: Pick<RunsPort, "onRunStart" | "onRunEnd" | "onLiveCost" | "spentToday">;
  readonly outbox: Pick<Outbox, "view">;
  readonly settings: (
    ownerId: string,
  ) => Pick<AutomationSettings, "autoResume" | "dailyBudgetUsd" | "timezone">;
}

export interface UsageStream {
  /** Publishes a limited session's current view again (its resume was cancelled). */
  refresh(ownerId: string, sessionId: string): void;
  /** Clears the pending `spend` timers. */
  stop(): void;
}

interface SpendState {
  last: number;
  timer: TimerHandle | null;
}

export function createUsageStream(deps: UsageStreamDeps): UsageStream {
  const { hub, clock, port } = deps;
  const lookup = deps.runs.lookup;
  const spend = new Map<string, SpendState>();

  function viewOf(row: RunRow): LimitView {
    const key = row.limitResetAt === null ? null : resumeKey(row.sessionId, row.id, row.limitResetAt);
    const effect = key === null ? null : deps.outbox.view(key);
    const resume =
      effect === null
        ? "none"
        : effect.cancelled
          ? "cancelled"
          : effect.status === "pending" || effect.status === "leased"
            ? "scheduled"
            : "none";
    return {
      sessionId: row.sessionId,
      runId: row.id,
      resetAt: row.limitResetAt,
      resume,
      provider: row.provider,
      model: row.model,
    };
  }

  const spentOf = (ownerId: string) => {
    const { dailyBudgetUsd, timezone } = deps.settings(ownerId);
    return { todayUsd: port.spentToday(ownerId, timezone), budgetUsd: dailyBudgetUsd };
  };

  function publishSpend(ownerId: string, state: SpendState): void {
    state.last = clock.now();
    hub.publish("usage", ownerId, { kind: "spend", ...spentOf(ownerId) });
  }

  function spendChanged(ownerId: string): void {
    if (!hub.hasSubscribers("usage", ownerId)) return;
    const state = spend.get(ownerId) ?? { last: Number.NEGATIVE_INFINITY, timer: null };
    spend.set(ownerId, state);
    if (state.timer) return;
    const wait = state.last + SPEND_EVERY_MS - clock.now();
    if (wait <= 0) return publishSpend(ownerId, state);
    state.timer = clock.setTimeout(
      () =>
        void guardTimer(
          deps.logger,
          "usage_spend",
          () => {
            state.timer = null;
            if (hub.hasSubscribers("usage", ownerId)) publishSpend(ownerId, state);
          },
          clock,
        ),
      wait,
    );
  }

  hub.registerSnapshot("usage", (ownerId) => {
    const settings = deps.settings(ownerId);
    return {
      kind: "snapshot",
      limits: lookup.limitedSessions(ownerId, USAGE_MAX_LIMITS).map(viewOf),
      ...spentOf(ownerId),
      autoResume: settings.autoResume,
    };
  });

  port.onRunEnd((event) => {
    if (event.status === "limited") {
      const row = lookup.get(event.runId);
      if (row) hub.publish("usage", event.ownerId, { kind: "limit", limit: viewOf(row) });
    }
    spendChanged(event.ownerId);
  });
  port.onRunStart((event) => {
    if (lookup.latestBefore(event.sessionId, event.runId)?.status === "limited")
      hub.publish("usage", event.ownerId, { kind: "limit_cleared", sessionId: event.sessionId });
  });
  port.onLiveCost((_sessionId, ownerId) => spendChanged(ownerId));

  return {
    refresh(ownerId, sessionId) {
      const row = lookup.latestOf(sessionId);
      if (row?.status === "limited" && row.ownerId === ownerId)
        hub.publish("usage", ownerId, { kind: "limit", limit: viewOf(row) });
    },
    stop() {
      for (const state of spend.values()) if (state.timer) clock.clearTimeout(state.timer);
      spend.clear();
    },
  };
}
