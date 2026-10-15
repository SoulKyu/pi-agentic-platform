import { AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { manualInput, parsedInput } from "./testing/bed.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

function make() {
  bed = createRunnerBed();
  bed.settings.value = AutomationSettings.parse({ slots: 4 });
}
const capped = (name: string, dailyBudgetUsd: number | null) =>
  bed.trigger(
    parsedInput({ ...manualInput(bed.folder, name), execution: { cwd: bed.folder, dailyBudgetUsd } }),
  );

/** Fires and starts one task of the trigger. */
async function running(trigger: { id: string; revision: number }, gated = true) {
  const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput({ gated }));
  await bed.engine.runner.handleStart({ taskId: taskId as string }, effectContext());
  return taskId as string;
}
const row = (id: string) =>
  bed.db.get<{ state: string; reason: string | null }>("SELECT state, reason FROM tasks WHERE id = $id", {
    id,
  });

describe("a trigger's own daily budget across its running tasks (M10R66)", () => {
  it("fails the trigger's running gated tasks with budget once their cost today reaches it, and no other trigger's", async () => {
    make();
    const limited = capped("Limited", 1);
    const free = capped("Free", null);
    const first = await running(limited);
    const second = await running(limited);
    const elsewhere = await running(free);
    bed.runs.taskSpend.set(first, 0.4);
    bed.runs.liveCost("s1", 0.4);
    expect([first, second, elsewhere].map((id) => row(id)?.state)).toEqual(["running", "running", "running"]);
    bed.order.length = 0;
    bed.runs.taskSpend.set(second, 0.6);
    bed.runs.liveCost("s2", 0.6);
    expect(row(first)).toEqual({ state: "failed", reason: "budget" });
    expect(row(second)).toEqual({ state: "failed", reason: "budget" });
    expect(row(elsewhere)?.state).toBe("running");
    await bed.clock.advance(0);
    expect(bed.order).toEqual(
      expect.arrayContaining(["ending:s1:budget", "ending:s2:budget", "abort:s1", "abort:s2"]),
    );
    expect(bed.order).not.toContain("abort:s3");
  });

  it("stays below the line: a trigger under its budget keeps running", async () => {
    make();
    const limited = capped("Limited", 1);
    const id = await running(limited);
    bed.runs.taskSpend.set(id, 0.99);
    bed.runs.liveCost("s1", 0.99);
    expect(row(id)?.state).toBe("running");
  });

  it("lets a browser's manual fire (gated = 0) run on, as for the owner's budget", async () => {
    make();
    const limited = capped("Limited", 1);
    const gated = await running(limited);
    const browser = await running(limited, false);
    bed.runs.taskSpend.set(gated, 2);
    bed.runs.liveCost("s1", 2);
    expect(row(gated)?.state).toBe("failed");
    expect(row(browser)?.state).toBe("running");
  });

  it("aborts no interactive run: the owner's own Resume now click (origin user) and a chat go on", async () => {
    make();
    const limited = capped("Limited", 1);
    const id = await running(limited);
    bed.runs.startRun("clicked", null, "u1", "user");
    bed.order.length = 0;
    bed.runs.taskSpend.set(id, 1);
    bed.runs.liveCost("clicked", 1);
    await bed.clock.advance(0);
    expect(row(id)?.state).toBe("failed");
    expect(bed.order).not.toContain("abort:clicked");
    expect(bed.order).not.toContain("ending:clicked:budget");
  });

  describe("a task the owner resumed by hand, over its trigger's own budget (JOIN 3, m1)", () => {
    const limitedTask = async () => {
      const id = await running(capped("Limited", 1));
      bed.runs.endRun({ sessionId: "s1", status: "limited", taskId: id, limitResetAt: bed.clock.now() + 1 });
      return id;
    };

    it("is not stopped: the click on the task's own session runs outside its trigger's line", async () => {
      make();
      const id = await limitedTask();
      bed.runs.startRun("s1", null, "u1", "user");
      expect(row(id)?.state).toBe("running");
      bed.order.length = 0;
      bed.runs.taskSpend.set(id, 3);
      bed.runs.liveCost("s1", 3);
      await bed.clock.advance(0);
      expect(row(id)?.state).toBe("running");
      expect(bed.order).not.toContain("abort:s1");
      expect(bed.order).not.toContain("ending:s1:budget");
    });

    it("is stopped by the trigger's budget on its next automatic resume", async () => {
      make();
      const id = await limitedTask();
      bed.runs.startRun("s1", null, "u1", "user");
      bed.runs.endRun({ sessionId: "s1", status: "limited", limitResetAt: bed.clock.now() + 1 });
      bed.runs.startRun("s1", id, "u1", "resume");
      bed.order.length = 0;
      bed.runs.taskSpend.set(id, 3);
      bed.runs.liveCost("s1", 3);
      await bed.clock.advance(0);
      expect(row(id)).toEqual({ state: "failed", reason: "budget" });
      expect(bed.order).toEqual(expect.arrayContaining(["ending:s1:budget", "abort:s1"]));
    });
  });

  it("leaves an automatic resume run alone when only a trigger's budget is reached", async () => {
    make();
    const limited = capped("Limited", 1);
    const id = await running(limited);
    bed.runs.startRun("resumed", null, "u1", "resume");
    bed.order.length = 0;
    bed.runs.taskSpend.set(id, 1);
    bed.runs.liveCost("resumed", 1);
    await bed.clock.advance(0);
    expect(row(id)?.state).toBe("failed");
    expect(bed.order).not.toContain("abort:resumed");
  });

  it("does nothing for another owner's event", async () => {
    make();
    const limited = capped("Limited", 1);
    const id = await running(limited);
    bed.runs.taskSpend.set(id, 5);
    bed.runs.liveCost("elsewhere", 1, "u2");
    expect(row(id)?.state).toBe("running");
  });
});
