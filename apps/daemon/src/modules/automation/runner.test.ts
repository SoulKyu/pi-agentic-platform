import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createRunnerBed, deferred, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const queue = (input = fireInput()) => {
  const trigger = bed.trigger();
  const result = bed.engine.fire(trigger.id, trigger.revision, input);
  return { trigger, taskId: result.taskId as string };
};
const start = (signal?: AbortSignal) =>
  bed.engine.runner.handleStart({ taskId: "any" }, effectContext(signal));
const row = (id: string) =>
  bed.db.get<Record<string, string | number | null>>("SELECT * FROM tasks WHERE id = $id", { id });

describe("the task.start handler", () => {
  it("creates the session with the stored policy, records the origin, then prompts: running with the session id", async () => {
    bed = createRunnerBed();
    const { taskId, trigger } = queue();
    expect(await start()).toEqual({ outcome: "done" });
    expect(bed.sessions.createTaskSession).toHaveBeenCalledWith({
      ownerId: "u1",
      cwd: bed.folder,
      policy: {
        mode: "auto-accept-edits",
        tools: ["read", "grep", "find", "ls"],
        preset: "read-only",
        tainted: false,
      },
    });
    expect(bed.runs.port.expectOrigin).toHaveBeenCalledWith("s1", { origin: "manual", taskId });
    expect(bed.sessions.prompt).toHaveBeenCalledWith({
      ownerId: "u1",
      sessionId: "s1",
      text: "Look at the repository and report.",
    });
    expect(bed.order).toEqual(["create:s1", "expect:s1", "prompt:s1"]);
    expect(row(taskId)).toMatchObject({ state: "running", session_id: "s1", started_at: bed.clock.now() });
    expect(bed.db.get("SELECT last_start_at FROM triggers WHERE id = $id", { id: trigger.id })).toEqual({
      last_start_at: bed.clock.now(),
    });
  });

  it("starts a tainted task with the taint set before the first call", async () => {
    bed = createRunnerBed();
    const trigger = bed.webhook();
    bed.triggers.setEnabled(bed.owner(), trigger.id, true);
    const revision = bed.triggers.get("u1", trigger.id)?.revision ?? 0;
    bed.engine.fire(
      trigger.id,
      revision,
      fireInput({
        source: "webhook",
        payload: { text: "boom", source: "webhook" },
        gates: { exemptDisabled: false },
      }),
    );
    await start();
    expect(bed.sessions.createTaskSession.mock.calls[0]?.[0].policy).toMatchObject({
      mode: "supervised",
      tainted: true,
    });
  });

  it("keeps the task queued and defers 30 s when the session cannot be created for capacity", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    bed.sessions.createTaskSession.mockRejectedValueOnce(new PapError("capacity"));
    expect(await start()).toEqual({ outcome: "defer", until: bed.clock.now() + 30_000 });
    expect(row(taskId)).toMatchObject({ state: "queued", session_id: null });
    expect(bed.engine.starting()).toEqual([]);
  });

  it.each(["invalid_cwd", "disk_low", "worker_failed"] as const)("fails the task with %s", async (code) => {
    bed = createRunnerBed();
    const { taskId } = queue();
    bed.sessions.createTaskSession.mockRejectedValueOnce(new PapError(code));
    expect(await start()).toEqual({ outcome: "done" });
    expect(row(taskId)).toMatchObject({ state: "failed", reason: code, ended_at: bed.clock.now() });
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
  });

  it("fails an unknown error with a closed reason and never its text", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    bed.sessions.createTaskSession.mockRejectedValueOnce(new Error("secret path /home/x"));
    await start();
    expect(row(taskId)).toMatchObject({ state: "failed", reason: "start_failed" });
  });

  it("fails with invalid_cwd, before any session, when the folder is gone at start", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    bed.db.run("UPDATE tasks SET cwd = '/nonexistent/pap-folder' WHERE id = $id", { id: taskId });
    await start();
    expect(row(taskId)).toMatchObject({ state: "failed", reason: "invalid_cwd" });
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
  });

  it("refuses a folder that is now inside pap's own state", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    bed.db.run("UPDATE tasks SET cwd = $home WHERE id = $id", { id: taskId, home: bed.home });
    await start();
    expect(row(taskId)).toMatchObject({ state: "failed", reason: "invalid_cwd" });
  });

  it("waits 35 s for a worker without any deadline of its own: running once, one session", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    const gate = deferred<{ sessionId: string }>();
    bed.sessions.createTaskSession.mockImplementationOnce(() => gate.promise);
    const pending = start();
    await bed.clock.advance(35_000);
    expect(row(taskId)?.state).toBe("queued");
    gate.resolve({ sessionId: "s-late" });
    expect(await pending).toEqual({ outcome: "done" });
    expect(row(taskId)).toMatchObject({ state: "running", session_id: "s-late" });
    expect(bed.sessions.createTaskSession).toHaveBeenCalledTimes(1);
    expect(bed.sessions.prompt).toHaveBeenCalledTimes(1);
  });

  it("archives and releases the new session and settles done when the task was cancelled during the start", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    const gate = deferred<{ sessionId: string }>();
    bed.sessions.createTaskSession.mockImplementationOnce(() => gate.promise);
    const pending = start();
    await bed.engine.runner.cancel("u1", taskId);
    gate.resolve({ sessionId: "s-orphan" });
    expect(await pending).toEqual({ outcome: "done" });
    expect(row(taskId)).toMatchObject({ state: "cancelled", session_id: null });
    expect(bed.sessions.archive).toHaveBeenCalledWith("u1", "s-orphan");
    expect(bed.sessions.releaseIdle).toHaveBeenCalledWith("u1", "s-orphan");
    expect(bed.policy.ended).toEqual(["s-orphan"]);
    expect(bed.sessions.prompt).not.toHaveBeenCalled();
    expect(bed.runs.port.expectOrigin).not.toHaveBeenCalled();
  });

  it("retries later and discards the new session when the signal aborted before the commit", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    const controller = new AbortController();
    const gate = deferred<{ sessionId: string }>();
    bed.sessions.createTaskSession.mockImplementationOnce(() => gate.promise);
    const pending = start(controller.signal);
    controller.abort();
    gate.resolve({ sessionId: "s-late" });
    expect(await pending).toEqual({ outcome: "retry", code: "deadline" });
    expect(row(taskId)).toMatchObject({ state: "queued", session_id: null });
    expect(bed.sessions.archive).toHaveBeenCalledWith("u1", "s-late");
    expect(bed.sessions.releaseIdle).toHaveBeenCalledWith("u1", "s-late");
    expect(bed.engine.starting()).toEqual([]);
  });

  it("does not start a session when the signal is already aborted", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    const controller = new AbortController();
    controller.abort();
    expect(await start(controller.signal)).toEqual({ outcome: "retry", code: "deadline" });
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
    expect(row(taskId)?.state).toBe("queued");
  });

  it.each(["handled", "queued"] as const)(
    "fails prompt_rejected when the prompt answers %s",
    async (disposition) => {
      bed = createRunnerBed();
      const { taskId } = queue();
      bed.sessions.prompt.mockResolvedValueOnce(disposition);
      expect(await start()).toEqual({ outcome: "done" });
      expect(row(taskId)).toMatchObject({ state: "failed", reason: "prompt_rejected" });
      expect(bed.runs.port.clearExpected).toHaveBeenCalledWith("s1");
      expect(bed.sessions.releaseIdle).toHaveBeenCalledWith("u1", "s1");
    },
  );

  it("fails with the error code when the prompt itself throws", async () => {
    bed = createRunnerBed();
    const { taskId } = queue();
    bed.sessions.prompt.mockRejectedValueOnce(new PapError("capacity"));
    await start();
    expect(row(taskId)).toMatchObject({ state: "failed", reason: "capacity" });
  });

  it("emits a task event for each move with the state it left", async () => {
    bed = createRunnerBed();
    const seen: Array<[string, string | null]> = [];
    bed.engine.events.on((event) => {
      if (event.kind === "task") seen.push([event.task.state, event.previous]);
    });
    queue();
    await start();
    expect(seen).toEqual([
      ["queued", null],
      ["running", "queued"],
    ]);
  });
});
