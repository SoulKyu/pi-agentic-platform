import { afterEach, describe, expect, it } from "vitest";
import { enqueueEffect } from "../../kernel/outbox/index.ts";
import { ABORT_NEXT_MS } from "./abort-next.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const row = (id: string) =>
  bed.db.get<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = $id", { id });
const aborts = () => bed.order.filter((entry) => entry === "abort:s1").length;

/** A running task whose resume has passed its sent mark; `reopening` says the worker is still coming up. */
async function resentTask(reopening: boolean): Promise<string> {
  bed = createRunnerBed();
  const trigger = bed.trigger();
  const id = bed.engine.fire(trigger.id, trigger.revision, fireInput()).taskId as string;
  await bed.engine.runner.handleStart({ taskId: id }, effectContext());
  enqueueEffect(
    bed.db,
    {
      kind: "run.resume",
      ownerId: "u1",
      payload: { sessionId: "s1", runId: "r1", resetAt: 5 },
      dedupKey: "resume:s1:r1:5",
    },
    bed.clock.now(),
  );
  bed.db.run(
    "UPDATE outbox SET status = 'leased', lease_until = $now + 60000, sent_at = $now WHERE dedup_key = 'resume:s1:r1:5'",
    {
      now: bed.clock.now(),
    },
  );
  bed.resending.value = reopening;
  return id;
}

describe("Cancel against a resume already sent into a reopening worker (M10R105)", () => {
  it("aborts the continuation at its start, once, and the task ends cancelled", async () => {
    const id = await resentTask(true);
    await bed.engine.runner.cancel("u1", id);
    expect(row(id)?.state).toBe("cancelled");
    expect(aborts()).toBe(1);
    bed.runs.startRun("s1", null, "u1", "user");
    expect(aborts()).toBe(2);
    expect(row(id)?.state).toBe("cancelled");
  });

  it("does not touch the owner's next prompt in the same session", async () => {
    const id = await resentTask(true);
    await bed.engine.runner.cancel("u1", id);
    bed.runs.startRun("s1", null, "u1", "user");
    bed.runs.endRun({ sessionId: "s1", status: "cancelled", origin: "user" });
    bed.runs.startRun("s1", null, "u1", "user");
    expect(aborts()).toBe(2);
  });

  it("lets the flag expire when no run ever starts", async () => {
    const id = await resentTask(true);
    await bed.engine.runner.cancel("u1", id);
    await bed.clock.advance(ABORT_NEXT_MS);
    bed.runs.startRun("s1", null, "u1", "user");
    expect(aborts()).toBe(1);
  });

  it("behaves as before on a warm session: only Cancel's own abort", async () => {
    const id = await resentTask(false);
    await bed.engine.runner.cancel("u1", id);
    bed.runs.startRun("s1", null, "u1", "user");
    expect(aborts()).toBe(1);
  });

  it("drops the flag when the continuation ends without a run, so the owner's next prompt runs", async () => {
    const id = await resentTask(true);
    await bed.engine.runner.cancel("u1", id);
    bed.runs.skipResume("s1", "send_failed");
    bed.runs.startRun("s1", null, "u1", "user");
    expect(aborts()).toBe(1);
  });

  it("drops the flag when the continuation was answered handled (no run follows)", async () => {
    const id = await resentTask(true);
    await bed.engine.runner.cancel("u1", id);
    bed.runs.skipResume("s1", "handled");
    bed.runs.startRun("s1", null, "u1", "user");
    expect(aborts()).toBe(1);
  });

  it("arms on the continuation itself, not on what the session reports of its worker (a closing one)", async () => {
    const id = await resentTask(true);
    bed.sessions.state.mockReturnValue(null);
    await bed.engine.runner.cancel("u1", id);
    bed.runs.startRun("s1", null, "u1", "user");
    expect(aborts()).toBe(2);
  });

  it("arms nothing for a resume that was not sent yet", async () => {
    const id = await resentTask(true);
    bed.db.run("UPDATE outbox SET sent_at = NULL");
    await bed.engine.runner.cancel("u1", id);
    bed.runs.startRun("s1", null, "u1", "user");
    expect(aborts()).toBe(1);
  });
});
