import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createResume } from "./resume.ts";
import { createRunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";
import { openResumeBed, type ResumeBed } from "./testing/resume-bed.ts";

let t: ResumeBed;
beforeEach(() => {
  t = openResumeBed({ createRunsService, createRunsStore, createResume });
});
afterEach(() => t.close());

const MIN = 60_000;
const reachReset = () => t.bed.clock.advance(MIN + 60_000);
/** A task's run in the session ends on the quota limit. */
function limitedTaskRun(taskId: string): void {
  t.sessionTasks.set("s1", taskId);
  t.runs.port.expectOrigin("s1", { origin: "trigger", taskId });
  t.limitRun("You have hit your usage limit. Try again in ~1 min.");
}

describe("the resume against the task's own trigger budget (JOIN 3, m2)", () => {
  it("skips the scheduled resume of a task whose trigger is over its line: no message is sent", async () => {
    limitedTaskRun("t1");
    t.overTasks.add("t1");
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:budget"]);
  });

  it("resumes a task whose trigger is under its line", async () => {
    limitedTaskRun("t1");
    t.overTasks.add("t2");
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
    expect(t.skipped).toEqual([]);
  });

  it("does not ask the trigger for a click: Resume now runs outside it", async () => {
    limitedTaskRun("t1");
    t.overTasks.add("t1");
    await t.resume.resumeNow({ userId: "u1", kind: "session" }, "s1");
    expect(t.sessions.prompts).toHaveLength(1);
  });
});

describe("after a Resume now click the chain keeps the task (JOIN 3, I1)", () => {
  /** The click's run is the owner's own: no task. It ends limited, and the next resume is planned from it. */
  function clickedThenLimited(): void {
    t.sessionTasks.set("s1", "t1");
    t.limitRun("You have hit your usage limit. Try again in ~1 min.");
    expect(t.runs.lookup.latestOf("s1")).toMatchObject({ origin: "user", taskId: null });
  }

  it("checks the trigger's budget for the task of the session: skipped, no message", async () => {
    clickedThenLimited();
    t.overTasks.add("t1");
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.skipped).toEqual(["s1:budget"]);
  });

  it("sends the resume with the task id, so its run counts toward the trigger", async () => {
    clickedThenLimited();
    await reachReset();
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
    expect(t.expected).toEqual([{ origin: "resume", taskId: "t1" }]);
    t.startRun();
    expect(t.runs.lookup.latestOf("s1")).toMatchObject({ origin: "resume", taskId: "t1" });
  });
});
