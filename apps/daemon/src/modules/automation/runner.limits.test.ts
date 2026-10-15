import { AUTOMATION_LIMITS, AutomationSettings } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const MINUTE = 60_000;

/** Fires and starts one task; `change` edits the stored row before it starts (a cap, a deadline). */
async function running(change: Record<string, number> = {}, input: Parameters<typeof fireInput>[0] = {}) {
  const trigger = bed.trigger();
  const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput(input));
  const id = taskId as string;
  for (const [column, value] of Object.entries(change))
    bed.db.run(`UPDATE tasks SET ${column} = $value WHERE id = $id`, { id, value });
  await bed.engine.runner.handleStart({ taskId: id }, effectContext());
  return id;
}
const row = (id: string) =>
  bed.db.get<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = $id", { id });

describe("the deadline (M10R39)", () => {
  it("marks the run, fails the task with deadline, then aborts; the late run end changes nothing", async () => {
    bed = createRunnerBed();
    const id = await running({ max_run_ms: 5 * MINUTE });
    bed.order.length = 0;
    await bed.clock.advance(5 * MINUTE - 1);
    expect(row(id)?.state).toBe("running");
    await bed.clock.advance(1);
    expect(row(id)).toMatchObject({ state: "failed", reason: "deadline", ended_at: bed.clock.now() });
    expect(bed.order.slice(0, 2)).toEqual(["ending:s1:deadline", "abort:s1"]);
    bed.runs.endRun({ sessionId: "s1", status: "cancelled", errorClass: "deadline", taskId: id });
    expect(row(id)).toMatchObject({ state: "failed", reason: "deadline" });
  });

  it("is cleared when the run ends first", async () => {
    bed = createRunnerBed();
    const id = await running({ max_run_ms: 5 * MINUTE });
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    await bed.clock.advance(10 * MINUTE);
    expect(row(id)).toMatchObject({ state: "done", reason: null });
    expect(bed.sessions.abort).not.toHaveBeenCalled();
  });

  it("starts again from zero when a limited task runs again", async () => {
    bed = createRunnerBed();
    const id = await running({ max_run_ms: 5 * MINUTE });
    await bed.clock.advance(4 * MINUTE);
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId: id, limitResetAt: bed.clock.now() + 1 });
    await bed.clock.advance(20 * MINUTE);
    expect(row(id)?.state).toBe("limited");
    bed.runs.startRun("s1", id);
    await bed.clock.advance(4 * MINUTE);
    expect(row(id)?.state).toBe("running");
    await bed.clock.advance(MINUTE);
    expect(row(id)).toMatchObject({ state: "failed", reason: "deadline" });
  });

  it("logs a timer whose store throws once, and the next timer still fires", async () => {
    bed = createRunnerBed();
    const first = await running({ max_run_ms: 5 * MINUTE });
    const second = await running({ max_run_ms: 6 * MINUTE });
    bed.db.run(
      `CREATE TRIGGER no_fail BEFORE UPDATE ON tasks WHEN NEW.state = 'failed' AND OLD.id = '${first}'
       BEGIN SELECT RAISE(ABORT, 'store broken'); END`,
    );
    await bed.clock.advance(5 * MINUTE);
    expect(row(first)?.state).toBe("running");
    expect(bed.logs.filter((line) => line.msg === "task_deadline_failed")).toHaveLength(1);
    await bed.clock.advance(MINUTE);
    expect(row(second)).toMatchObject({ state: "failed", reason: "deadline" });
  });
});

describe("the cost cap of one run (M10R39)", () => {
  it("fails the task with run_budget once the run's cost reaches max_run_usd, then aborts", async () => {
    bed = createRunnerBed();
    const id = await running({ max_run_usd: 1 });
    bed.order.length = 0;
    bed.runs.liveCost("s1", 0.99);
    expect(row(id)?.state).toBe("running");
    bed.runs.liveCost("s1", 1.01);
    expect(row(id)).toMatchObject({ state: "failed", reason: "run_budget" });
    await bed.clock.advance(0);
    expect(bed.order.slice(0, 2)).toEqual(["ending:s1:run_budget", "abort:s1"]);
    // Later messages of the dying run change nothing and abort nothing twice.
    bed.runs.liveCost("s1", 1.5);
    await bed.clock.advance(0);
    expect(bed.order.filter((entry) => entry.startsWith("abort:"))).toHaveLength(1);
  });

  it("gives a task resumed after a quota reset a fresh cap, the daily budget bounding the total", async () => {
    bed = createRunnerBed();
    const id = await running({ max_run_usd: 1 });
    bed.runs.liveCost("s1", 0.9);
    bed.runs.endRun({ sessionId: "s1", status: "limited", taskId: id, limitResetAt: bed.clock.now() + 1 });
    bed.runs.startRun("s1", id);
    // The new run is at 0.4 of its own: 1.3 in all for the task, within its per-run cap.
    bed.runs.liveCost("s1", 0.4);
    expect(row(id)?.state).toBe("running");
    bed.runs.liveCost("s1", 1);
    expect(row(id)).toMatchObject({ state: "failed", reason: "run_budget" });
  });

  it("puts no cap on a task without max_run_usd", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.runs.liveCost("s1", 500);
    expect(row(id)?.state).toBe("running");
  });
});

describe("the daily budget across runs (M10R39, M10R66)", () => {
  const budget = (dailyBudgetUsd: number | null) => {
    bed.settings.value = AutomationSettings.parse({ dailyBudgetUsd });
  };

  it("aborts every running gated task of the owner with budget when today reaches the budget", async () => {
    bed = createRunnerBed();
    budget(5);
    const a = await running();
    const b = await running();
    bed.runs.spent.value = 4.8;
    bed.runs.liveCost("s1", 2.4);
    expect([row(a)?.state, row(b)?.state]).toEqual(["running", "running"]);
    bed.order.length = 0;
    bed.runs.spent.value = 5;
    bed.runs.liveCost("s2", 2.4);
    expect(row(a)).toMatchObject({ state: "failed", reason: "budget" });
    expect(row(b)).toMatchObject({ state: "failed", reason: "budget" });
    await bed.clock.advance(0);
    expect(bed.order).toEqual(
      expect.arrayContaining(["ending:s1:budget", "ending:s2:budget", "abort:s1", "abort:s2"]),
    );
  });

  it("lets a browser's manual fire (gated = 0) run on to its own caps", async () => {
    bed = createRunnerBed();
    budget(5);
    const gated = await running();
    const manual = await running({}, { gated: false });
    bed.runs.spent.value = 5;
    bed.runs.liveCost("s1", 2);
    expect(row(gated)?.state).toBe("failed");
    expect(row(manual)?.state).toBe("running");
  });

  describe("a task the owner resumed by hand (M10R106)", () => {
    const limitedTask = async () => {
      budget(5);
      const id = await running();
      bed.runs.endRun({ sessionId: "s1", status: "limited", taskId: id, limitResetAt: bed.clock.now() + 1 });
      return id;
    };

    it("keeps running when other automation spend reaches the budget", async () => {
      bed = createRunnerBed();
      const id = await limitedTask();
      bed.runs.startRun("s1", null, "u1", "user");
      expect(row(id)?.state).toBe("running");
      const other = await running();
      bed.runs.spent.value = 5;
      bed.runs.liveCost("s2", 1);
      await bed.clock.advance(0);
      expect(row(other)).toMatchObject({ state: "failed", reason: "budget" });
      expect(row(id)?.state).toBe("running");
      expect(bed.order).not.toContain("abort:s1");
    });

    it("is gated again by the budget on its next automatic resume", async () => {
      bed = createRunnerBed();
      const id = await limitedTask();
      bed.runs.startRun("s1", null, "u1", "user");
      bed.runs.endRun({ sessionId: "s1", status: "limited", limitResetAt: bed.clock.now() + 1 });
      bed.runs.startRun("s1", id, "u1", "resume");
      bed.runs.spent.value = 5;
      bed.runs.liveCost("s1", 1);
      expect(row(id)).toMatchObject({ state: "failed", reason: "budget" });
    });
  });

  it("aborts an automatic resume run that has no task, and only aborts it", async () => {
    bed = createRunnerBed();
    budget(5);
    const task = await running();
    bed.runs.startRun("resumed", null, "u1", "resume");
    bed.runs.startRun("chat", null, "u1", "user");
    bed.order.length = 0;
    bed.runs.spent.value = 5;
    bed.runs.liveCost("resumed", 1);
    await bed.clock.advance(0);
    expect(row(task)?.state).toBe("failed");
    expect(bed.order).toEqual(expect.arrayContaining(["ending:resumed:budget", "abort:resumed"]));
    expect(bed.order).not.toContain("abort:chat");
  });

  it("never aborts a click-resume: the owner's own run (origin user, no task) is outside the budget (M10R106)", async () => {
    bed = createRunnerBed();
    budget(5);
    bed.runs.startRun("clicked", null, "u1", "user");
    bed.runs.spent.value = 50;
    bed.runs.liveCost("clicked", 20);
    await bed.clock.advance(0);
    expect(bed.sessions.abort).not.toHaveBeenCalled();
    expect(bed.order).not.toContain("ending:clicked:budget");
  });

  it("forgets a resume run that ended", async () => {
    bed = createRunnerBed();
    budget(5);
    bed.runs.startRun("resumed", null, "u1", "resume");
    bed.runs.endRun({ sessionId: "resumed", status: "completed", origin: "resume" });
    bed.runs.spent.value = 5;
    bed.runs.liveCost("other", 1);
    await bed.clock.advance(0);
    expect(bed.sessions.abort).not.toHaveBeenCalled();
  });

  it("does nothing without a budget, or below it, or for another owner's tasks", async () => {
    bed = createRunnerBed();
    const mine = await running();
    budget(null);
    bed.runs.spent.value = 1_000;
    bed.runs.liveCost("s1", 1);
    expect(row(mine)?.state).toBe("running");
    budget(5);
    bed.settings.owners.set("u2", AutomationSettings.parse({ dailyBudgetUsd: 5 }));
    bed.runs.spent.value = 4.99;
    bed.runs.liveCost("s1", 1);
    expect(row(mine)?.state).toBe("running");
    bed.runs.spent.value = 6;
    bed.runs.liveCost("elsewhere", 1, "u2");
    expect(row(mine)?.state).toBe("running");
  });
});

describe("the question timeout (M10R39, owner m10a3)", () => {
  const wait = AUTOMATION_LIMITS.inputWaitMinutes * MINUTE;

  it("denies the open questions after ten minutes, tells the Inbox, and the run goes on to done", async () => {
    bed = createRunnerBed();
    const id = await running();
    const seen: Array<[string, number]> = [];
    bed.engine.events.on((event) => {
      if (event.kind === "attention_timeout") seen.push([event.taskId, event.denied]);
    });
    bed.sessions.attend("s1", true);
    await bed.clock.advance(wait - 1);
    expect(bed.sessions.answerUnattended).not.toHaveBeenCalled();
    await bed.clock.advance(1);
    expect(bed.sessions.answerUnattended).toHaveBeenCalledTimes(1);
    expect(bed.sessions.answerUnattended).toHaveBeenCalledWith("u1", "s1");
    expect(seen).toEqual([[id, 1]]);
    expect(row(id)?.state).toBe("running");
    bed.sessions.attend("s1", false);
    await bed.clock.advance(wait / 2);
    expect(bed.sessions.answerUnattended).toHaveBeenCalledTimes(1);
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    expect(row(id)?.state).toBe("done");
  });

  it("is disarmed by an answer at nine minutes", async () => {
    bed = createRunnerBed();
    await running();
    bed.sessions.attend("s1", true);
    await bed.clock.advance(9 * MINUTE);
    bed.sessions.attend("s1", false);
    await bed.clock.advance(wait);
    expect(bed.sessions.answerUnattended).not.toHaveBeenCalled();
  });

  it("is cleared when the task ends, and ignores a session no running task owns", async () => {
    bed = createRunnerBed();
    const id = await running();
    bed.sessions.attend("stranger", true);
    bed.sessions.attend("s1", true);
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
    await bed.clock.advance(wait * 2);
    expect(bed.sessions.answerUnattended).not.toHaveBeenCalled();
  });

  it("waits again when the session is still waiting after the denial", async () => {
    bed = createRunnerBed();
    await running({ max_run_ms: 60 * MINUTE });
    bed.sessions.state.mockReturnValue({ archived: false, running: true, needsInput: true });
    bed.sessions.attend("s1", true);
    await bed.clock.advance(wait);
    await bed.clock.advance(wait);
    expect(bed.sessions.answerUnattended).toHaveBeenCalledTimes(2);
  });

  it("passes the question on to the Inbox as an attention event", async () => {
    bed = createRunnerBed();
    const id = await running();
    const seen: Array<[string, boolean]> = [];
    bed.engine.events.on((event) => {
      if (event.kind === "attention") seen.push([event.taskId, event.needsInput]);
    });
    bed.sessions.attend("s1", true);
    bed.sessions.attend("s1", false);
    expect(seen).toEqual([
      [id, true],
      [id, false],
    ]);
  });
});
