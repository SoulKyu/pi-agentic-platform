import type { AutomationSettings } from "@pap/contracts";
import type { Clock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import type { Logger } from "../../../kernel/logger.ts";
import type { AgentSpend, RunsPort } from "../../runs/index.ts";
import type { PushNotifier } from "../service.ts";

export interface BudgetSourceDeps {
  readonly db: Db;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Pick<Logger, "warn">;
  readonly notifier: Pick<PushNotifier, "notify" | "keyOf">;
  readonly runs: Pick<RunsPort, "onRunEnd" | "spentToday">;
  readonly spend: Pick<AgentSpend, "agentSpentToday" | "agentsRunToday">;
  readonly settings: (ownerId: string) => Pick<AutomationSettings, "dailyBudgetUsd" | "timezone">;
  /** The registry name and the budget of an agent; nothing else of it is read. */
  readonly agents: {
    get(
      ownerId: string,
      agentId: string,
    ): { readonly name: string; readonly input: { readonly budget: BudgetLimits } | null } | null;
  };
  /** The agent a session belongs to, null for a plain one. */
  readonly kindOf: (sessionId: string) => { readonly agentId: string | null } | null;
  /** The instance owner, for the boot check; null before the first owner exists. */
  readonly ownerId: () => string | null;
}

interface BudgetLimits {
  readonly usdPerDay: number | null;
  readonly tokensPerDay: number | null;
}

/** `yyyy-mm-dd` of `at` on the owner's zone clock (null: the server's own); a 25 h day is one day. */
export function zoneDay(at: number, timeZone: string | null): string {
  return new Intl.DateTimeFormat("en-CA", {
    ...(timeZone === null ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/**
 * Budgets as a push source (M12R25, M12R26): at each run end, and once at boot, a limit that is reached makes one `budget`
 * push per scope per zone day. The day is part of the ref, and the event row, in any state, is the memory: a restart
 * cannot push twice, and a settled push cannot come back the same day. A budget of 0 is "no run could start", not news.
 * The push names the scope only by its ref; the wire has no amount (M12R7). Errors are logged, never rethrown into the run.
 */
export function wireBudgetSource(deps: BudgetSourceDeps) {
  const { notifier } = deps;

  function reached(ownerId: string, scope: { ref: string; name?: string }): void {
    const key = notifier.keyOf("budget", "budget", scope.ref);
    if (
      deps.db.get("SELECT 1 AS one FROM push_events WHERE owner_id = $owner AND dedup_key = $key", {
        owner: ownerId,
        key,
      }) !== undefined
    )
      return;
    notifier.notify({
      ownerId,
      cls: "budget",
      refKind: "budget",
      refId: scope.ref,
      ...(scope.name === undefined ? {} : { name: scope.name }),
    });
  }

  function checkOwner(ownerId: string, day: string, timeZone: string | null, limit: number | null): void {
    if (limit === null || limit <= 0) return;
    if (deps.runs.spentToday(ownerId, timeZone) >= limit) reached(ownerId, { ref: `owner:${day}` });
  }

  function checkAgent(ownerId: string, agentId: string, day: string, timeZone: string | null): void {
    const agent = deps.agents.get(ownerId, agentId);
    const budget = agent?.input?.budget;
    if (!agent || !budget) return;
    const { usdPerDay, tokensPerDay } = budget;
    if ((usdPerDay ?? 0) <= 0 && (tokensPerDay ?? 0) <= 0) return;
    const spent = deps.spend.agentSpentToday(ownerId, agentId, timeZone);
    if (
      (usdPerDay !== null && usdPerDay > 0 && spent.usd >= usdPerDay) ||
      (tokensPerDay !== null && tokensPerDay > 0 && spent.tokens >= tokensPerDay)
    )
      reached(ownerId, { ref: `agent:${agentId}:${day}`, name: agent.name });
  }

  function guarded(what: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      deps.logger.warn("push_budget_check_failed", { what, err: error });
    }
  }

  const stop = deps.runs.onRunEnd((event) =>
    guarded("run_end", () => {
      const { dailyBudgetUsd, timezone } = deps.settings(event.ownerId);
      const day = zoneDay(deps.clock.now(), timezone);
      checkOwner(event.ownerId, day, timezone, dailyBudgetUsd);
      const agentId = deps.kindOf(event.sessionId)?.agentId;
      if (agentId) checkAgent(event.ownerId, agentId, day, timezone);
    }),
  );

  return {
    stop,
    /** Once at boot, for the day in progress, so a restart after the limit was reached loses nothing (M12R26). */
    boot(): void {
      guarded("boot", () => {
        const ownerId = deps.ownerId();
        if (ownerId === null) return;
        const { dailyBudgetUsd, timezone } = deps.settings(ownerId);
        const day = zoneDay(deps.clock.now(), timezone);
        checkOwner(ownerId, day, timezone, dailyBudgetUsd);
        for (const agentId of deps.spend.agentsRunToday(ownerId, timezone))
          checkAgent(ownerId, agentId, day, timezone);
      });
    },
  };
}
