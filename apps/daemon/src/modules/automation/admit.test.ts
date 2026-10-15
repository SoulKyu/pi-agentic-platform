import { AutomationSettings, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerBed, deferred, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const fire = (triggerId: string, ownerId = "u1") => {
  const revision = bed.triggers.get(ownerId, triggerId)?.revision ?? 0;
  const result = bed.engine.fire(triggerId, revision, fireInput({ ownerId }));
  if (result.verdict !== "fired") throw new Error(result.verdict);
  return result.taskId as string;
};
const start = () => bed.engine.runner.handleStart({ taskId: "any" }, effectContext());
const state = (id: string) => bed.tasks().find((task) => task.id === id)?.state;

describe("admission", () => {
  it("holds a third task while two run (slots 2) and starts it when one ends", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const [a, b, c] = [fire(trigger.id), fire(trigger.id), fire(trigger.id)] as [string, string, string];
    await start();
    await start();
    expect([state(a), state(b), state(c)]).toEqual(["running", "running", "queued"]);
    const held = await start();
    expect(held).toEqual({ outcome: "defer", until: bed.clock.now() + 10_000 });
    expect(state(c)).toBe("queued");
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: a });
    expect(state(a)).toBe("done");
    expect(await start()).toEqual({ outcome: "done" });
    expect(state(c)).toBe("running");
  });

  it("serves the trigger that started longest ago first: a noisy trigger cannot starve a quiet one", async () => {
    bed = createRunnerBed();
    const noisy = bed.trigger();
    const quiet = bed.trigger(undefined, bed.owner());
    const noisyIds = Array.from({ length: 20 }, () => fire(noisy.id));
    await bed.clock.advance(5);
    const quietId = fire(quiet.id);
    await start();
    await start();
    expect(state(noisyIds[0] as string)).toBe("running");
    expect(state(quietId)).toBe("running");
    expect(state(noisyIds[1] as string)).toBe("queued");
  });

  it("takes the oldest queued task of the chosen trigger", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const first = fire(trigger.id);
    await bed.clock.advance(5);
    const second = fire(trigger.id);
    await start();
    expect([state(first), state(second)]).toEqual(["running", "queued"]);
  });

  it("never picks a task twice: a second task.start while the first is starting takes the next task", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const first = fire(trigger.id);
    await bed.clock.advance(5);
    const second = fire(trigger.id);
    const gate = deferred<{ sessionId: string }>();
    bed.sessions.createTaskSession.mockImplementationOnce(() => gate.promise);
    const pending = start();
    await Promise.resolve();
    expect(bed.engine.starting()).toEqual([first]);
    await start();
    expect(bed.sessions.createTaskSession).toHaveBeenCalledTimes(2);
    expect(state(second)).toBe("running");
    gate.resolve({ sessionId: "s-slow" });
    await pending;
    expect(state(first)).toBe("running");
    expect(bed.engine.starting()).toEqual([]);
  });

  it("counts a task being started as a slot", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    for (let n = 0; n < 3; n++) fire(trigger.id);
    const gates = [deferred<{ sessionId: string }>(), deferred<{ sessionId: string }>()];
    bed.sessions.createTaskSession
      .mockImplementationOnce(() => (gates[0] as (typeof gates)[number]).promise)
      .mockImplementationOnce(() => (gates[1] as (typeof gates)[number]).promise);
    const first = start();
    const second = start();
    await Promise.resolve();
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 10_000 });
    gates[0]?.resolve({ sessionId: "sa" });
    gates[1]?.resolve({ sessionId: "sb" });
    await Promise.all([first, second]);
  });

  it("keeps slots per owner: a full owner does not hold another owner's task", async () => {
    bed = createRunnerBed();
    bed.settings.owners.set("u1", AutomationSettings.parse({ slots: 1 }));
    const mine = bed.trigger();
    const theirs = bed.trigger(undefined, bed.other());
    const [m1, m2] = [fire(mine.id), fire(mine.id)] as [string, string];
    const t1 = fire(theirs.id, "u2");
    await start();
    await start();
    expect([state(m1), state(m2), state(t1)]).toEqual(["running", "queued", "running"]);
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 10_000 });
  });

  it("defers 30 s while the owner is paused and loses nothing", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const id = fire(trigger.id);
    bed.settings.value = { ...bed.settings.value, paused: true };
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(state(id)).toBe("queued");
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
    bed.settings.value = { ...bed.settings.value, paused: false };
    expect(await start()).toEqual({ outcome: "done" });
    expect(state(id)).toBe("running");
  });

  it("serves the other owner while one is paused", async () => {
    bed = createRunnerBed();
    const mine = bed.trigger();
    const theirs = bed.trigger(undefined, bed.other());
    const m = fire(mine.id);
    const t = fire(theirs.id, "u2");
    bed.settings.owners.set("u1", AutomationSettings.parse({ paused: true }));
    expect(await start()).toEqual({ outcome: "done" });
    expect([state(m), state(t)]).toEqual(["queued", "running"]);
  });

  it("is done at once when nothing is queued", async () => {
    bed = createRunnerBed();
    expect(await start()).toEqual({ outcome: "done" });
  });

  it("does not count a limited task as a slot", async () => {
    bed = createRunnerBed();
    const trigger = bed.trigger();
    const ids = [fire(trigger.id), fire(trigger.id), fire(trigger.id)] as [string, string, string];
    await start();
    await start();
    bed.runs.endRun({
      sessionId: "s1",
      status: "limited",
      taskId: ids[0],
      limitResetAt: bed.clock.now() + 3_600_000,
    });
    expect(state(ids[0])).toBe("limited");
    expect(await start()).toEqual({ outcome: "done" });
    expect(state(ids[2])).toBe("running");
  });

  it("groups the tasks of deleted triggers as one trigger that started when its last task did", async () => {
    bed = createRunnerBed();
    const gone = bed.trigger();
    const kept = bed.trigger();
    const orphans = [fire(gone.id), fire(gone.id)] as [string, string];
    await bed.clock.advance(5);
    const keptId = fire(kept.id);
    bed.triggers.remove(bed.owner(), gone.id);
    await start();
    expect(state(orphans[0])).toBe("running");
    await bed.clock.advance(5);
    bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: orphans[0] });
    await start();
    expect(state(keptId)).toBe("running");
    expect(state(orphans[1])).toBe("queued");
  });

  it("admits owner B's task while owner A's keeps getting capacity: no owner goes first by name", async () => {
    bed = createRunnerBed();
    const mine = bed.trigger();
    const theirs = bed.trigger(undefined, bed.other());
    const a = fire(mine.id);
    await bed.clock.advance(5);
    const b = fire(theirs.id, "u2");
    bed.sessions.createTaskSession.mockRejectedValueOnce(new PapError("capacity"));
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(state(a)).toBe("queued");
    expect(await start()).toEqual({ outcome: "done" });
    expect([state(a), state(b)]).toEqual(["queued", "running"]);
    // Only A's task is left and it is put off: look again in 30 s, then it starts.
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    await bed.clock.advance(30_000);
    expect(await start()).toEqual({ outcome: "done" });
    expect(state(a)).toBe("running");
  });
});
