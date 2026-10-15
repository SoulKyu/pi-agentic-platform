import { AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { manualInput, parsedInput } from "./testing/bed.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const NOON_UTC = Date.UTC(2026, 9, 14, 12, 0, 0);
const settle = (change: Record<string, unknown>) => {
  bed.settings.value = AutomationSettings.parse(change);
};
const fireAt = (trigger: { id: string; revision: number }, over: Parameters<typeof fireInput>[0] = {}) =>
  bed.engine.fire(trigger.id, trigger.revision, fireInput(over));
const journal = (triggerId: string) =>
  bed.db.all<{ verdict: string; count: number }>(
    "SELECT verdict, count FROM trigger_fires WHERE trigger_id = $triggerId ORDER BY id",
    { triggerId },
  );

describe("the gates in order (M10R57)", () => {
  it("answers paused for a fire that is paused and over budget", () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    settle({ paused: true, dailyBudgetUsd: 0 });
    expect(fireAt(trigger)).toEqual({ verdict: "paused" });
  });

  it("answers disabled before budget for a source that is not exempt", () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    settle({ dailyBudgetUsd: 0 });
    expect(fireAt(trigger, { gates: { exemptDisabled: false } })).toEqual({ verdict: "disabled" });
  });

  it("lets a manual fire of a disabled trigger past disabled, and the budget still gates a token's", () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    expect(fireAt(trigger).verdict).toBe("fired");
    settle({ dailyBudgetUsd: 0 });
    expect(fireAt(trigger)).toEqual({ verdict: "budget" });
  });

  it("checks the budget before the dedup window and the full queue", () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    for (let queued = 0; queued < 20; queued += 1) expect(fireAt(trigger).verdict).toBe("fired");
    expect(fireAt(trigger).verdict).toBe("queue_full");
    settle({ dailyBudgetUsd: 0 });
    expect(fireAt(trigger).verdict).toBe("budget");
  });
});

describe("the daily budget (M10R66)", () => {
  it("counts the day in the automation time zone: midnight in Auckland against UTC", async () => {
    // Auckland is UTC+13 on 2026-10-14: its day began at 11:00Z, UTC's at 00:00Z.
    bed = createRunnerBed({ realRuns: true, startAt: Date.UTC(2026, 9, 14, 5, 0, 0) });
    const trigger = bed.trigger();
    const earlier = fireAt(trigger, { gated: false }).taskId as string;
    bed.spend(earlier, 4);
    await bed.clock.advance(NOON_UTC - bed.clock.now());
    settle({ dailyBudgetUsd: 3, timezone: "UTC" });
    expect(fireAt(trigger)).toEqual({ verdict: "budget" });
    settle({ dailyBudgetUsd: 3, timezone: "Pacific/Auckland" });
    expect(fireAt(trigger).verdict).toBe("fired");
  });

  it("stops the third token fire: two runs of $0.20 reach a $0.30 budget", () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    settle({ dailyBudgetUsd: 0.3 });
    const first = fireAt(trigger);
    expect(first.verdict).toBe("fired");
    bed.spend(first.taskId as string, 0.2);
    const second = fireAt(trigger);
    expect(second.verdict).toBe("fired");
    bed.spend(second.taskId as string, 0.2);
    expect(fireAt(trigger)).toEqual({ verdict: "budget" });
    expect(journal(trigger.id).at(-1)).toEqual({ verdict: "budget", count: 1 });
  });

  it("fires a browser's manual fire past the budget (gated = 0) and counts its cost for the next token fire", () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    settle({ dailyBudgetUsd: 0.3 });
    const first = fireAt(trigger);
    bed.spend(first.taskId as string, 0.2);
    bed.spend(fireAt(trigger).taskId as string, 0.2);
    const browser = fireAt(trigger, { gated: false });
    expect(browser.verdict).toBe("fired");
    expect(bed.db.get("SELECT gated FROM tasks WHERE id = $id", { id: browser.taskId ?? null })).toEqual({
      gated: 0,
    });
    bed.spend(browser.taskId as string, 5);
    expect(fireAt(trigger)).toEqual({ verdict: "budget" });
  });

  it("counts the live cost of a run in flight: $4.90 finished plus $0.20 live", () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    const ids = [fireAt(trigger, { gated: false }), fireAt(trigger, { gated: false })].map(
      (result) => result.taskId as string,
    );
    bed.spend(ids[0] as string, 4.9);
    expect(fireAt(trigger).verdict).toBe("fired");
    bed.spend(ids[1] as string, 0.2, { live: true });
    expect(fireAt(trigger)).toEqual({ verdict: "budget" });
  });

  it("applies the trigger's own budget to the runs of its tasks, live included, and no other trigger's", () => {
    bed = createRunnerBed({ realRuns: true });
    const capped = bed.trigger(
      parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, dailyBudgetUsd: 1 } }),
    );
    const other = bed.trigger(manualInput(bed.folder, "Other"));
    const first = fireAt(capped);
    expect(first.verdict).toBe("fired");
    bed.spend(first.taskId as string, 0.6);
    expect(fireAt(capped).verdict).toBe("fired");
    bed.spend(fireAt(capped, { gated: false }).taskId as string, 0.5, { live: true });
    expect(fireAt(capped)).toEqual({ verdict: "budget" });
    expect(fireAt(other).verdict).toBe("fired");
    expect(fireAt(capped, { gated: false }).verdict).toBe("fired");
  });

  it("refuses every gated fire with a budget of 0, a trigger's own included", () => {
    bed = createRunnerBed({ realRuns: true });
    const free = bed.trigger();
    const zero = bed.trigger(
      parsedInput({ ...manualInput(bed.folder, "Zero"), execution: { cwd: bed.folder, dailyBudgetUsd: 0 } }),
    );
    expect(fireAt(zero)).toEqual({ verdict: "budget" });
    settle({ dailyBudgetUsd: 0 });
    expect(fireAt(free)).toEqual({ verdict: "budget" });
    expect(fireAt(free, { gated: false }).verdict).toBe("fired");
  });

  it("has no gate without a budget", () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    settle({ dailyBudgetUsd: null });
    bed.spend(fireAt(trigger, { gated: false }).taskId as string, 1_000);
    expect(fireAt(trigger).verdict).toBe("fired");
  });
});

describe("a queued gated task that starts after the budget was spent", () => {
  it("fails with budget and creates no session; an ungated one starts", async () => {
    bed = createRunnerBed({ realRuns: true });
    const trigger = bed.trigger();
    const gated = fireAt(trigger).taskId as string;
    const browser = fireAt(trigger, { gated: false }).taskId as string;
    bed.spend(browser, 5);
    await bed.engine.runner.handleStart({ taskId: gated }, effectContext());
    expect(bed.db.get("SELECT state, reason FROM tasks WHERE id = $id", { id: gated })).toEqual({
      state: "failed",
      reason: "budget",
    });
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
    await bed.engine.runner.handleStart({ taskId: browser }, effectContext());
    expect(bed.sessions.createTaskSession).toHaveBeenCalledTimes(1);
  });

  it("fails it for its trigger's own budget too", async () => {
    bed = createRunnerBed({ realRuns: true });
    const capped = bed.trigger(
      parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, dailyBudgetUsd: 1 } }),
    );
    const queued = fireAt(capped).taskId as string;
    bed.spend(fireAt(capped, { gated: false }).taskId as string, 1);
    await bed.engine.runner.handleStart({ taskId: queued }, effectContext());
    expect(bed.db.get("SELECT state, reason FROM tasks WHERE id = $id", { id: queued })).toEqual({
      state: "failed",
      reason: "budget",
    });
  });
});
