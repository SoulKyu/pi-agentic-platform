import type { AutomationSettings } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { RunsPort } from "../runs/index.ts";
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
}

/**
 * The daily budget (M10R66). The owner's line is the setting against today's spend of every automatic run, finished or
 * open (the runs registry counts them, in the automation time zone); a trigger's own line is its `dailyBudgetUsd`
 * against the runs of its tasks. A budget of 0 is reached before anything runs; null is no line. The fire, the start of a
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

  return {
    ownerOver,
    triggerOver,
    /** The owner's line or the trigger's (none for a task whose trigger is gone). */
    over: (ownerId: string, triggerId: string | null): boolean =>
      ownerOver(ownerId) || (triggerId !== null && triggerOver(ownerId, triggerId)),
    /** Today's spend, for the dry-run's budget line. */
    spentToday: (ownerId: string): number =>
      runs.spentToday(ownerId, deps.settings.automation(ownerId).timezone),
  };
}
export type Gates = ReturnType<typeof createGates>;
