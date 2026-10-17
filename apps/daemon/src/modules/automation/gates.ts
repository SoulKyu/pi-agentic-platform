import type { AutomationSettings } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { RunsPort } from "../runs/index.ts";
import type { AgentBudget } from "./agent-budget.ts";
import type { TaskStore } from "./tasks.ts";
import type { TriggerRecord } from "./triggers.ts";

/** A task that ended before this cannot have a run today (a day is at most 25 hours): it is left out of the trigger's sum. */
const TRIGGER_TASK_WINDOW_MS = 48 * 3_600_000;

export interface GatesDeps {
  readonly clock: Clock;
  readonly settings: { automation(ownerId: string): AutomationSettings };
  readonly runs: Pick<RunsPort, "spentToday" | "spentTodayOf">;
  readonly triggers: { get(ownerId: string, id: string): TriggerRecord | null };
  readonly store: Pick<TaskStore, "idsOfTriggerSince">;
  /** The agents' own daily budget (M11R74); none: no agent line. */
  readonly agentBudget?: Pick<AgentBudget, "over">;
}

/**
 * The daily budget (M10R66). The owner's line is the setting against today's spend of every automatic run, finished or
 * open (the runs registry counts them, in the automation time zone); a trigger's own line is its `dailyBudgetUsd`
 * against the runs of its tasks; an agent's own line (M11R74) is its profile's budget against its runs. A budget of 0 is reached before anything runs; null is no line. The fire, the start of a
 * queued task and the live cost of a run read the same answers.
 */
export function createGates(deps: GatesDeps) {
  const { runs } = deps;

  function ownerOver(ownerId: string): boolean {
    const { dailyBudgetUsd, timezone } = deps.settings.automation(ownerId);
    return dailyBudgetUsd !== null && runs.spentToday(ownerId, timezone) >= dailyBudgetUsd;
  }

  function triggerSpent(ownerId: string, triggerId: string): number {
    const { timezone } = deps.settings.automation(ownerId);
    const taskIds = deps.store.idsOfTriggerSince(triggerId, deps.clock.now() - TRIGGER_TASK_WINDOW_MS);
    return runs.spentTodayOf(ownerId, timezone, taskIds);
  }

  function triggerOver(ownerId: string, triggerId: string): boolean {
    const budget = deps.triggers.get(ownerId, triggerId)?.input?.execution.dailyBudgetUsd ?? null;
    return budget !== null && triggerSpent(ownerId, triggerId) >= budget;
  }

  /** The agent a gated start belongs to: the one named, else the trigger's (a task whose trigger is gone names its own). */
  function agentOver(ownerId: string, triggerId: string | null, agentId: string | null): boolean {
    const agent =
      agentId ?? (triggerId === null ? null : (deps.triggers.get(ownerId, triggerId)?.agentId ?? null));
    return agent !== null && (deps.agentBudget?.over(ownerId, agent) ?? false);
  }

  return {
    ownerOver,
    triggerOver,
    /** The agent's own line (M11R74): the running tasks of an agent are stopped by it. */
    agentOver: (ownerId: string, agentId: string): boolean =>
      deps.agentBudget?.over(ownerId, agentId) ?? false,
    /** The owner's line, the trigger's or the agent's (none for a task whose trigger is gone). */
    over: (ownerId: string, triggerId: string | null, agentId: string | null = null): boolean =>
      ownerOver(ownerId) ||
      (triggerId !== null && triggerOver(ownerId, triggerId)) ||
      agentOver(ownerId, triggerId, agentId),
    /**
     * A running or limited task's own lines, for a quota resume (the owner's line is the resume's own check): its
     * trigger's and its agent's budget. A task that is not gated answers false.
     */
    taskOver: (
      ownerId: string,
      row: { readonly gated: number; readonly trigger_id: string | null; readonly agent_id: string | null },
    ): boolean =>
      row.gated === 1 &&
      ((row.trigger_id !== null && triggerOver(ownerId, row.trigger_id)) ||
        (row.agent_id !== null && agentOver(ownerId, row.trigger_id, row.agent_id))),
    /** Today's spend, for the dry-run's budget line. */
    spentToday: (ownerId: string): number =>
      runs.spentToday(ownerId, deps.settings.automation(ownerId).timezone),
  };
}
export type Gates = ReturnType<typeof createGates>;
