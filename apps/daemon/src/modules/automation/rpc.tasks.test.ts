import {
  type Caller,
  type HandlerContext,
  type HandlerTable,
  presetOfTools,
  TOKEN_PERMISSIONS,
} from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { testCaller } from "../../testing/caller.ts";
import { automationRpc, taskActions } from "./rpc.ts";
import { createRunnerBed, effectContext, fireInput, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

function setup() {
  bed = createRunnerBed();
  const dispatch = createDispatcher({
    handlers: automationRpc(
      bed.triggers,
      taskActions(bed.engine.runner, bed.engine.stream, bed.releaseTools()),
      bed.operations(),
    ) as unknown as HandlerTable,
    receipts: createReceiptStore(bed.db, bed.clock),
    logger: bed.logger,
  });
  const opened: Array<[string, string]> = [];
  let frameId = 0;
  const call = (
    method: string,
    params: unknown,
    caller: Caller = bed.owner(),
    commandId = `c-${frameId + 1}`,
  ) => {
    const ctx: HandlerContext = {
      caller,
      connectionId: "c1",
      openSubscription: (stream, key) => {
        opened.push([stream, key]);
        return "sub-1";
      },
      closeSubscription: () => {},
    };
    return dispatch({ id: ++frameId, method, params, commandId }, ctx);
  };
  return { call, opened };
}
const token = (): Caller =>
  testCaller({ kind: "token", credentialId: "tok1", permissions: new Set(TOKEN_PERMISSIONS) });
const reader = (): Caller => testCaller({ permissions: new Set(["automation:read"]) });

async function failedTask(enabled = false, policy?: unknown): Promise<string> {
  const created = bed.trigger();
  if (enabled) bed.triggers.setEnabled(bed.owner(), created.id, true);
  // Enabling bumps the revision: fire against the current one.
  const trigger = bed.triggers.get("u1", created.id) ?? created;
  const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
  bed.db.run(
    "UPDATE tasks SET state = 'failed', reason = 'provider', ended_at = 1, policy = COALESCE($policy, policy) WHERE id = $id",
    { id: taskId as string, policy: policy === undefined ? null : JSON.stringify(policy) },
  );
  return taskId as string;
}

describe("the task methods", () => {
  it("opens the tasks stream keyed by the caller's own id, never by a param", async () => {
    const { call, opened } = setup();
    const reply = await call("subscribe.tasks", {}, testCaller({ userId: "u7" }));
    expect(reply).toMatchObject({ ok: true, result: { sub: "sub-1" } });
    expect(opened).toEqual([["tasks", "u7"]]);
  });

  it("refuses a reader who lacks automation:operate, and answers not_found for an unknown task", async () => {
    const { call } = setup();
    expect(await call("automation.tasks.cancel", { taskId: "x" }, reader())).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await call("automation.tasks.cancel", { taskId: "nope" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await call("automation.failures.dismiss", { effectId: 99 })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("cancels a queued task for the caller's owner only", async () => {
    const { call } = setup();
    const trigger = bed.trigger();
    const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
    expect(await call("automation.tasks.cancel", { taskId }, testCaller({ userId: "u2" }))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await call("automation.tasks.cancel", { taskId })).toMatchObject({ ok: true, result: { taskId } });
    expect(bed.tasks()[0]?.state).toBe("cancelled");
  });

  it("makes a token's retry budget-gated and a browser's not", async () => {
    const { call } = setup();
    const taskId = await failedTask(true);
    const browser = await call("automation.tasks.retry", { taskId });
    const viaToken = await call("automation.tasks.retry", { taskId }, token());
    const gated = (reply: unknown) =>
      bed.db.get<{ gated: number }>("SELECT gated FROM tasks WHERE id = $id", {
        id: (reply as { result: { taskId: string } }).result.taskId,
      })?.gated;
    expect([gated(browser), gated(viaToken)]).toEqual([0, 1]);
  });

  it("refuses a token's retry on a disabled trigger, and keeps the owner's own (M10R57)", async () => {
    const { call } = setup();
    const taskId = await failedTask();
    const before = bed.tasks().length;
    expect(await call("automation.tasks.retry", { taskId }, token())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(bed.tasks()).toHaveLength(before);
    expect(await call("automation.tasks.retry", { taskId })).toMatchObject({ ok: true });
  });

  it("runs a token's retry with the trigger's current tools and mode, and the owner's with the old task's", async () => {
    const { call } = setup();
    const wide = { mode: "auto-accept-edits", tools: ["read", "bash"], preset: "full", env: [] };
    const taskId = await failedTask(true, wide);
    const policyOf = (reply: unknown) =>
      JSON.parse(
        bed.db.get<{ policy: string }>("SELECT policy FROM tasks WHERE id = $id", {
          id: (reply as { result: { taskId: string } }).result.taskId,
        })?.policy ?? "null",
      );
    const triggerId = bed.db.get<{ trigger_id: string }>("SELECT trigger_id FROM tasks LIMIT 1")?.trigger_id;
    const execution = bed.triggers.get("u1", triggerId as string)?.input?.execution;
    const current = {
      mode: execution?.mode ?? "supervised",
      tools: [...(execution?.tools ?? [])],
      preset: presetOfTools(execution?.tools ?? []),
      env: [...(execution?.env ?? [])],
    };
    expect(current).not.toEqual(wide);

    expect(policyOf(await call("automation.tasks.retry", { taskId }, token()))).toEqual(current);
    expect(policyOf(await call("automation.tasks.retry", { taskId }))).toEqual(wide);
  });

  it("runs a token's retry under the trigger's current caps, and the owner's under the old task's", async () => {
    const { call } = setup();
    const taskId = await failedTask(true);
    const triggerId = bed.db.get<{ trigger_id: string }>("SELECT trigger_id FROM tasks LIMIT 1")?.trigger_id;
    // The owner adds a cap after the task ran.
    const config = JSON.parse(
      bed.db.get<{ config: string }>("SELECT config FROM triggers WHERE id = $id", {
        id: triggerId as string,
      })?.config ?? "{}",
    );
    config.execution.maxRunUsd = 0.5;
    config.execution.maxRunMinutes = 7;
    bed.db.run("UPDATE triggers SET config = $config WHERE id = $id", {
      id: triggerId as string,
      config: JSON.stringify(config),
    });
    const capsOf = (reply: unknown) =>
      bed.db.get<{ max_run_usd: number | null; max_run_ms: number }>(
        "SELECT max_run_usd, max_run_ms FROM tasks WHERE id = $id",
        { id: (reply as { result: { taskId: string } }).result.taskId },
      );
    const old = bed.db.get<{ max_run_usd: number | null; max_run_ms: number }>(
      "SELECT max_run_usd, max_run_ms FROM tasks WHERE id = $id",
      { id: taskId },
    );
    expect(old?.max_run_usd).not.toBe(0.5);

    expect(capsOf(await call("automation.tasks.retry", { taskId }, token()))).toEqual({
      max_run_usd: 0.5,
      max_run_ms: 7 * 60_000,
    });
    expect(capsOf(await call("automation.tasks.retry", { taskId }))).toEqual(old);
  });

  it("maps the pause to automation_paused", async () => {
    const { call } = setup();
    const taskId = await failedTask();
    bed.settings.value = { ...bed.settings.value, paused: true };
    expect(await call("automation.tasks.retry", { taskId })).toMatchObject({
      ok: false,
      error: { code: "automation_paused" },
    });
  });

  it("dismisses a failed effect of the caller's", async () => {
    const { call } = setup();
    bed.db.run(
      `INSERT INTO outbox (kind, replay, owner_id, payload, status, next_at, created_at, settled_at, last_error)
       VALUES ('task.start', 'process-bound', 'u1', '{"taskId":"x"}', 'failed', 0, 1, 1, 'crash')`,
    );
    expect(await call("automation.failures.dismiss", { effectId: 1 })).toMatchObject({ ok: true });
    expect(bed.outbox.failures("u1")).toEqual([]);
  });

  it("leaves a task that started alone when Cancel names another owner's id", async () => {
    const { call } = setup();
    const trigger = bed.trigger();
    const { taskId } = bed.engine.fire(trigger.id, trigger.revision, fireInput());
    await bed.engine.runner.handleStart({ taskId: taskId as string }, effectContext());
    await call("automation.tasks.cancel", { taskId }, testCaller({ userId: "u2" }));
    expect(bed.tasks()[0]?.state).toBe("running");
    expect(bed.sessions.abort).not.toHaveBeenCalled();
  });
});
