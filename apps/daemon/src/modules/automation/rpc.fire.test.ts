import type { Caller, HandlerContext, HandlerTable } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { testCaller } from "../../testing/caller.ts";
import type { PrecheckPort } from "./manual.ts";
import { automationRpc, taskActions } from "./rpc.ts";
import { manualInput, parsedInput } from "./testing/bed.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

function setup() {
  bed = createRunnerBed();
  const precheck = vi.fn<PrecheckPort["run"]>(async () => ({
    verdict: "pass",
    exitCode: 0,
    durationMs: 3,
    output: "ok",
  }));
  const dispatch = createDispatcher({
    handlers: automationRpc(
      bed.triggers,
      taskActions(bed.engine.runner, bed.engine.stream, bed.releaseTools()),
      bed.operations(precheck),
    ) as unknown as HandlerTable,
    receipts: createReceiptStore(bed.db, bed.clock),
    logger: bed.logger,
  });
  let frameId = 0;
  const call = (method: string, params: unknown, caller: Caller = bed.owner(), commandId?: string) => {
    const ctx: HandlerContext = {
      caller,
      connectionId: "c1",
      openSubscription: () => "sub-1",
      closeSubscription: () => {},
    };
    frameId += 1;
    return dispatch({ id: frameId, method, params, commandId: commandId ?? `c-${frameId}` }, ctx);
  };
  return { call, precheck };
}
const reader = (): Caller => testCaller({ permissions: new Set(["automation:read"]) });
const gatedOf = (taskId: string) =>
  bed.db.get<{ gated: number }>("SELECT gated FROM tasks WHERE id = $taskId", { taskId })?.gated;

describe("automation.fire", () => {
  it("fires the saved trigger, disabled or not, for the owner (gated = 0) and for a token (gated = 1)", async () => {
    const { call } = setup();
    const trigger = bed.trigger();
    const viaBrowser = await call("automation.fire", { triggerId: trigger.id });
    const viaToken = await call("automation.fire", { triggerId: trigger.id }, bed.token());
    expect(viaBrowser).toMatchObject({ ok: true, result: { verdict: "fired" } });
    const ids = [viaBrowser, viaToken].map(
      (reply) => (reply as { result: { taskId: string } }).result.taskId,
    );
    expect(ids.map(gatedOf)).toEqual([0, 1]);
  });

  it("answers a replayed commandId from the receipt, with one task", async () => {
    const { call } = setup();
    const trigger = bed.trigger();
    const first = await call("automation.fire", { triggerId: trigger.id }, bed.owner(), "same");
    const again = await call("automation.fire", { triggerId: trigger.id }, bed.owner(), "same");
    expect(again).toMatchObject({ ok: true, result: (first as { result: unknown }).result });
    expect(bed.tasks()).toHaveLength(1);
  });

  it("maps the pause, the budget and a full queue to their codes", async () => {
    const { call } = setup();
    const trigger = bed.trigger();
    bed.runs.spent.value = 5;
    expect(await call("automation.fire", { triggerId: trigger.id }, bed.token())).toMatchObject({
      ok: false,
      error: { code: "budget_reached" },
    });
    bed.settings.value = { ...bed.settings.value, paused: true };
    expect(await call("automation.fire", { triggerId: trigger.id })).toMatchObject({
      ok: false,
      error: { code: "automation_paused" },
    });
    bed.settings.value = { ...bed.settings.value, paused: false };
    for (let queued = 0; queued < 20; queued += 1) await call("automation.fire", { triggerId: trigger.id });
    expect(await call("automation.fire", { triggerId: trigger.id })).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });
  });

  it("has no parameter that raises a cap or a budget: an extra field is refused", async () => {
    const { call } = setup();
    const trigger = bed.trigger();
    const reply = await call("automation.fire", { triggerId: trigger.id, dailyBudgetUsd: 1000 }, bed.token());
    expect(reply).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(bed.tasks()).toEqual([]);
  });

  it("refuses a payload over 64 KiB and a caller without automation:operate", async () => {
    const { call } = setup();
    const trigger = bed.trigger();
    const big = await call("automation.fire", { triggerId: trigger.id, payload: "é".repeat(32_769) });
    expect(big).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await call("automation.fire", { triggerId: trigger.id }, reader())).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });
});

describe("automation.dryRun", () => {
  it("is idempotent, writes nothing and runs no precheck for a token", async () => {
    const { call, precheck } = setup();
    const trigger = bed.trigger(
      parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, precheck: "make check" } }),
    );
    const reply = await call("automation.dryRun", { triggerId: trigger.id }, bed.token(), undefined);
    expect(reply).toMatchObject({
      ok: true,
      result: { verdict: "fire", precheck: "not_run_token", tokens: "none" },
    });
    expect(precheck).not.toHaveBeenCalled();
    expect(bed.tasks()).toEqual([]);
  });

  it("runs the saved precheck for the owner's browser", async () => {
    const { call, precheck } = setup();
    const trigger = bed.trigger(
      parsedInput({ ...manualInput(bed.folder), execution: { cwd: bed.folder, precheck: "make check" } }),
    );
    const reply = await call("automation.dryRun", { triggerId: trigger.id });
    expect(reply).toMatchObject({ ok: true, result: { precheck: { verdict: "pass" } } });
    expect(precheck).toHaveBeenCalledTimes(1);
  });

  it("refuses a draft that fails TriggerInput, and neither a trigger nor a draft", async () => {
    const { call } = setup();
    expect(await call("automation.dryRun", { draft: { name: "" } })).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(await call("automation.dryRun", {})).toMatchObject({ error: { code: "bad_request" } });
  });

  it("is refused to a caller who cannot operate", async () => {
    const { call } = setup();
    expect(await call("automation.dryRun", { draft: manualInput(bed.folder) }, reader())).toMatchObject({
      error: { code: "forbidden" },
    });
  });
});

describe("automation.journal", () => {
  it("is read-only: a reader and a token see the owner's lines, another owner gets not_found", async () => {
    const { call } = setup();
    const trigger = bed.trigger();
    await call("automation.fire", { triggerId: trigger.id });
    for (const caller of [reader(), bed.token()]) {
      const reply = await call("automation.journal", { triggerId: trigger.id }, caller);
      expect(reply).toMatchObject({ ok: true, result: { hasMore: false, entries: [{ verdict: "fired" }] } });
    }
    expect(await call("automation.journal", { triggerId: trigger.id }, bed.other())).toMatchObject({
      error: { code: "not_found" },
    });
    expect(await call("automation.journal", { triggerId: trigger.id, before: 0 })).toMatchObject({
      error: { code: "bad_request" },
    });
  });
});
