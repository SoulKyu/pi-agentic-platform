import { type Caller, type HandlerContext, type HandlerTable, TOKEN_PERMISSIONS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { testCaller } from "../../testing/caller.ts";
import { automationRpc, taskActions } from "./rpc.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";
import { NO_CLIENT_PATHS } from "../../kernel/ws/client-path-gate.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

function setup() {
  bed = createRunnerBed();
  const calls: string[] = [];
  const clearTaskPolicy = vi.fn((_ownerId: string, sessionId: string) => {
    calls.push(`clear:${sessionId}`);
    bed.policy.released.add(sessionId);
  });
  bed.sessions.releaseIdle.mockImplementation((_ownerId, sessionId) => {
    calls.push(`release:${sessionId}`);
    return "released";
  });
  const releaseTools = bed.releaseTools(clearTaskPolicy);
  const dispatch = createDispatcher({
    gate: NO_CLIENT_PATHS,
    handlers: automationRpc(
      bed.triggers,
      taskActions(bed.engine.runner, bed.engine.stream, releaseTools),
      bed.operations(),
    ) as unknown as HandlerTable,
    receipts: createReceiptStore(bed.db, bed.clock),
    logger: bed.logger,
  });
  let frameId = 0;
  const call = (target: string | { sessionId: string }, caller: Caller = bed.owner()) => {
    const params = typeof target === "string" ? { taskId: target } : target;
    const ctx: HandlerContext = {
      caller,
      connectionId: "c1",
      openSubscription: () => "sub",
      closeSubscription: () => {},
    };
    frameId += 1;
    return dispatch(
      { id: frameId, method: "automation.tasks.releaseTools", params, commandId: `c-${frameId}` },
      ctx,
    );
  };
  return { call, calls, clearTaskPolicy };
}

async function started(): Promise<string> {
  const trigger = bed.trigger();
  const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
  await bed.engine.runner.handleStart({ taskId: taskId as string }, effectContext());
  return taskId as string;
}
async function finished(): Promise<string> {
  const id = await started();
  bed.runs.endRun({ sessionId: "s1", status: "completed", taskId: id });
  return id;
}
const taskFrames = () =>
  bed.frames
    .map((frame) => frame.event as { kind: string; task?: { toolsReleased: boolean } })
    .filter((event) => event.kind === "task");

describe("automation.tasks.releaseTools (M10R153, owner m10a7)", () => {
  /** The task failed and the 30-day rule removed its row; its session stays, with the trigger's list. */
  async function rowGone(): Promise<string> {
    const id = await started();
    bed.runs.endRun({ sessionId: "s1", status: "failed", taskId: id });
    await bed.clock.advance(31 * 86_400_000);
    bed.engine.store.removeEndedBefore(bed.clock.now() - 30 * 86_400_000);
    expect(bed.engine.store.get(id)).toBeUndefined();
    return "s1";
  }

  it("is refused to a token: automation:admin is outside what a token holds", async () => {
    const { call, clearTaskPolicy } = setup();
    const id = await finished();
    const token = testCaller({
      kind: "token",
      credentialId: "tok1",
      permissions: new Set(TOKEN_PERMISSIONS),
    });
    expect(await call(id, token)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(clearTaskPolicy).not.toHaveBeenCalled();
  });

  it("asks for the password step-up first, and changes nothing without it", async () => {
    const { call, clearTaskPolicy } = setup();
    const id = await finished();
    bed.sessions.releaseIdle.mockClear();
    expect(await call(id, bed.unconfirmed())).toMatchObject({
      ok: false,
      error: { code: "step_up_required" },
    });
    expect(clearTaskPolicy).not.toHaveBeenCalled();
    expect(bed.sessions.releaseIdle).not.toHaveBeenCalled();
    expect(bed.auditRows().filter((row) => row.reason === "automation task tools released")).toEqual([]);
  });

  it("refuses a task that is still running or waiting", async () => {
    const { call, clearTaskPolicy } = setup();
    const id = await started();
    expect(await call(id)).toMatchObject({ ok: false, error: { code: "session_busy" } });
    const trigger = bed.trigger();
    const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
    expect(await call(taskId as string)).toMatchObject({ ok: false, error: { code: "session_busy" } });
    expect(clearTaskPolicy).not.toHaveBeenCalled();
  });

  it("answers not_found for an unknown task, another owner's task and a finished task without a session", async () => {
    const { call } = setup();
    const id = await finished();
    expect(await call("nope")).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await call(id, bed.owner({ userId: "u2" }))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    const trigger = bed.trigger();
    const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
    bed.db.run("UPDATE tasks SET state = 'failed', reason = 'bad_policy', ended_at = 1 WHERE id = $id", {
      id: taskId as string,
    });
    expect(await call(taskId as string)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("releases the worker, then lifts the list, audits it and tells the board", async () => {
    const { call, calls } = setup();
    const id = await finished();
    calls.length = 0;
    const frames = taskFrames().length;
    expect(await call(id)).toMatchObject({ ok: true, result: { taskId: id } });
    expect(calls).toEqual(["release:s1", "clear:s1"]);
    expect(bed.auditRows().filter((row) => row.reason === "automation task tools released")).toEqual([
      expect.objectContaining({
        actor: "user",
        kind: "policy",
        decision: expect.any(String),
        detail: JSON.stringify({ taskId: id }),
      }),
    ]);
    const after = taskFrames();
    expect(after.length).toBe(frames + 1);
    expect(after.at(-1)?.task?.toolsReleased).toBe(true);
  });

  it("changes nothing when the worker is busy", async () => {
    const { call, calls, clearTaskPolicy } = setup();
    const id = await finished();
    bed.sessions.releaseIdle.mockImplementation(() => "busy");
    calls.length = 0;
    expect(await call(id)).toMatchObject({ ok: false, error: { code: "session_busy" } });
    expect(clearTaskPolicy).not.toHaveBeenCalled();
    expect(bed.policy.released.has("s1")).toBe(false);
    expect(bed.auditRows().filter((row) => row.reason === "automation task tools released")).toEqual([]);
  });

  it("lifts the list by session once the task row is gone, and audits it", async () => {
    const { call, calls } = setup();
    const sessionId = await rowGone();
    calls.length = 0;
    expect(await call({ sessionId })).toMatchObject({ ok: true, result: { taskId: null, sessionId } });
    expect(calls).toEqual(["release:s1", "clear:s1"]);
    expect(bed.auditRows().filter((row) => row.reason === "automation task tools released")).toEqual([
      expect.objectContaining({ actor: "user", kind: "policy", detail: JSON.stringify({ sessionId }) }),
    ]);
  });

  it("asks for the step-up and refuses a token when it goes by session", async () => {
    const { call, clearTaskPolicy } = setup();
    const sessionId = await rowGone();
    expect(await call({ sessionId }, bed.unconfirmed())).toMatchObject({
      ok: false,
      error: { code: "step_up_required" },
    });
    const token = testCaller({
      kind: "token",
      credentialId: "tok1",
      permissions: new Set(TOKEN_PERMISSIONS),
    });
    expect(await call({ sessionId }, token)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(clearTaskPolicy).not.toHaveBeenCalled();
  });

  it("answers not_found for another owner's session, an unknown session and a session without a list", async () => {
    const { call, clearTaskPolicy } = setup();
    const sessionId = await rowGone();
    bed.sessions.state.mockImplementation((ownerId) =>
      ownerId === "u1" ? { archived: true, running: false, needsInput: false } : null,
    );
    expect(await call({ sessionId }, bed.owner({ userId: "u2" }))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    bed.sessions.state.mockReturnValueOnce(null);
    expect(await call({ sessionId: "nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    bed.policy.released.add(sessionId);
    expect(await call({ sessionId })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(clearTaskPolicy).not.toHaveBeenCalled();
  });

  it("still refuses a session whose task is running", async () => {
    const { call } = setup();
    await started();
    expect(await call({ sessionId: "s1" })).toMatchObject({ ok: false, error: { code: "session_busy" } });
  });
});
