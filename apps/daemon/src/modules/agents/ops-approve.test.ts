import { PLATFORM_ARGS, PLATFORM_RESULTS } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createPlatformPort, PlatformRefusal, type PlatformContext } from "../platform/index.ts";
import { APPROVE_WAIT_MS, createApprove } from "./ops-approve.ts";
import { createRequestsBed, papCode, type RequestsBed } from "./testing/requests-bed.ts";

let t: RequestsBed;
afterEach(() => t.bed.dispose());

const MIN = 60_000;

async function setup() {
  t = await createRequestsBed();
  const approve = createApprove({ requests: t.requests, clock: t.bed.clock, logger: silentLogger });
  const ctx = (signal: AbortSignal, over: Partial<PlatformContext> = {}): PlatformContext => ({
    ownerId: "u1",
    sessionId: "t1",
    type: "agent-thread",
    tainted: false,
    agentId: t.agentId,
    signal,
    ...over,
  });
  const run = (
    args: { title: string; summary?: string } = { title: "Deploy to prod?" },
    over: Partial<PlatformContext> = {},
    controller = new AbortController(),
  ) => {
    const promise = approve(PLATFORM_ARGS["agent.approve"].parse(args), ctx(controller.signal, over));
    const settled: { value?: unknown; error?: unknown } = {};
    promise.then(
      (value) => (settled.value = value),
      (error: unknown) => (settled.error = error),
    );
    return { promise, controller, settled };
  };
  const pendingId = () =>
    t.bed.db.get<{ id: string }>("SELECT id FROM agent_requests WHERE state = 'pending'")?.id ?? "";
  return { run, pendingId };
}

describe("agent.approve (M11R102)", () => {
  it("opens a request with the stripped title and summary, and waits for the answer", async () => {
    const { run, pendingId } = await setup();
    const call = run({ title: "Deploy\u00A0to prod?", summary: "Runs\nthe migration." });
    await t.bed.clock.advance(0);
    const id = pendingId();
    const row = t.bed.db.get<{
      kind: string;
      title: string;
      detail: string;
      session_id: string;
      expires_at: number;
    }>("SELECT kind, title, detail, session_id, expires_at FROM agent_requests WHERE id = $id", { id });
    expect(row).toEqual({
      kind: "approve",
      title: "Deploy to prod?",
      detail: "Runs the migration.",
      session_id: "t1",
      expires_at: t.bed.clock.now() + APPROVE_WAIT_MS,
    });
    expect(call.settled).toEqual({});
  });

  it("answers {approved: true} when the owner approves", async () => {
    const { run, pendingId } = await setup();
    const call = run();
    await t.bed.clock.advance(0);
    await t.requests.answer(t.bed.owner(), pendingId(), true);
    const result = await call.promise;
    expect(PLATFORM_RESULTS["agent.approve"].parse(result)).toEqual({ approved: true });
    expect(t.bed.clock.pending()).toBe(0);
  });

  it("answers {approved: false} when the owner denies", async () => {
    const { run, pendingId } = await setup();
    const call = run();
    await t.bed.clock.advance(0);
    await t.requests.answer(t.bed.owner(), pendingId(), false);
    expect(await call.promise).toEqual({ approved: false });
  });

  it("answers {approved: false} after 25 minutes and marks the request expired", async () => {
    const { run, pendingId } = await setup();
    const call = run();
    await t.bed.clock.advance(0);
    const id = pendingId();
    await t.bed.clock.advance(24 * MIN);
    expect(call.settled).toEqual({});
    await t.bed.clock.advance(MIN);
    expect(call.settled).toEqual({ value: { approved: false } });
    expect(t.stateOf(id)?.state).toBe("expired");
    expect(t.resolved.at(-1)).toMatchObject({ refId: id, resolution: "timed_out" });
    expect(t.bed.clock.pending()).toBe(0);
  });

  it("ends the wait when the op's signal aborts: the request is cancelled and its item resolved", async () => {
    const { run, pendingId } = await setup();
    const call = run();
    await t.bed.clock.advance(0);
    const id = pendingId();
    call.controller.abort();
    expect(await call.promise).toEqual({ approved: false });
    expect(t.stateOf(id)?.state).toBe("cancelled");
    expect(t.resolved.at(-1)).toEqual({ ownerId: "u1", kind: "agent_approve", refId: id, resolution: null });
    expect(t.bed.clock.pending()).toBe(0);
  });

  it("opens nothing when the signal is already aborted", async () => {
    const { run } = await setup();
    const controller = new AbortController();
    controller.abort();
    const call = run(undefined, {}, controller);
    expect(await call.promise).toEqual({ approved: false });
    expect(t.upserts).toEqual([]);
  });

  it("refuses a fifth open approval of the agent with limit_reached, and a call with no agent with not_found", async () => {
    const { run } = await setup();
    for (let n = 0; n < 4; n += 1) run();
    await t.bed.clock.advance(0);
    const fifth = run();
    await expect(fifth.promise).rejects.toMatchObject({ code: "limit_reached" });
    await expect(run(undefined, { agentId: null }).promise).rejects.toBeInstanceOf(PlatformRefusal);
  });

  it("a token cannot answer it: forbidden, and the call keeps waiting", async () => {
    const { run, pendingId } = await setup();
    const call = run();
    await t.bed.clock.advance(0);
    const token = testCaller({ kind: "token", credentialId: "tok1" });
    expect(await papCode(() => t.requests.answer(token, pendingId(), true))).toBe("forbidden");
    expect(call.settled).toEqual({});
    expect(t.stateOf(pendingId())?.state).toBe("pending");
  });
});

describe("through the platform dispatcher", () => {
  it("a worker that dies mid-wait releases the call and cancels the request", async () => {
    const { pendingId } = await setup();
    const results: unknown[] = [];
    const platform = createPlatformPort({
      sessions: {
        kindOf: () => ({ ownerId: "u1", type: "agent-thread", tainted: false, agentId: t.agentId }),
        approvedCalls: { take: () => false },
      },
      audit: { append: () => {}, reserve: () => true },
      clock: t.bed.clock,
      logger: silentLogger,
      readOnly: false,
    });
    platform.register(
      "agent.approve",
      createApprove({ requests: t.requests, clock: t.bed.clock, logger: silentLogger }),
    );
    const reply = (record: unknown) => void results.push(record);
    platform.onRecord(
      { id: "t1", ownerId: "u1" },
      { type: "platform_call", id: "p1", op: "agent.approve", toolCallId: "tc1", args: { title: "Go?" } },
      reply,
    );
    await t.bed.clock.advance(0);
    const id = pendingId();
    expect(id).not.toBe("");
    platform.workerEnded({ id: "t1", ownerId: "u1" }, reply);
    await t.bed.clock.advance(0);
    expect(results).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "cancelled" }]);
    expect(t.stateOf(id)?.state).toBe("cancelled");
    expect(t.resolved.at(-1)).toMatchObject({ refId: id, resolution: null });
    expect(t.bed.clock.pending()).toBe(0);
  });

  it("a Stop (platform_cancel) ends it the same way, and the owner's answer after that is not_found", async () => {
    const { pendingId } = await setup();
    const results: unknown[] = [];
    const platform = createPlatformPort({
      sessions: {
        kindOf: () => ({ ownerId: "u1", type: "agent-thread", tainted: false, agentId: t.agentId }),
        approvedCalls: { take: () => false },
      },
      audit: { append: () => {}, reserve: () => true },
      clock: t.bed.clock,
      logger: silentLogger,
      readOnly: false,
    });
    platform.register(
      "agent.approve",
      createApprove({ requests: t.requests, clock: t.bed.clock, logger: silentLogger }),
    );
    const reply = (record: unknown) => void results.push(record);
    platform.onRecord(
      { id: "t1", ownerId: "u1" },
      { type: "platform_call", id: "p1", op: "agent.approve", toolCallId: "tc1", args: { title: "Go?" } },
      reply,
    );
    await t.bed.clock.advance(0);
    const id = pendingId();
    platform.onRecord({ id: "t1", ownerId: "u1" }, { type: "platform_cancel", id: "p1" }, reply);
    await t.bed.clock.advance(0);
    expect(t.stateOf(id)?.state).toBe("cancelled");
    expect(await papCode(() => t.requests.answer(t.bed.owner(), id, true))).toBe("not_found");
  });
});
