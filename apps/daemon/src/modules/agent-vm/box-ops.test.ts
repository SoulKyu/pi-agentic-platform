import { BOX_OP_LIMITS, type BoxOp, PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createBoxOps } from "./index.ts";
import type { GuestLink, OpResult } from "./guest-link.ts";
import type { AgentRuntime, VmPhase } from "./runtime.ts";

const PROJECT = "0b1c2d3e-0000-4000-8000-000000000001";
const STATUS: BoxOp = { name: "git.status" };
const STATE: BoxOp = { name: "knowledge.state" };

function bed(phase: VmPhase = "running") {
  const sent: Array<{ id: string; op: BoxOp }> = [];
  const listeners = new Set<(result: OpResult) => void>();
  let close: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const link: GuestLink = {
    spawnWorker: () => Promise.reject(new Error("unused")),
    shutdown: () => undefined,
    sendOp: (id, op) => {
      sent.push({ id, op });
      return true;
    },
    onOpResult: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    closed,
  };
  const runtime: Pick<AgentRuntime, "phase" | "link"> = {
    phase: () => phase,
    link: () => (phase === "running" ? link : undefined),
  };
  const clock = createFakeClock();
  return {
    sent,
    clock,
    ops: createBoxOps(runtime, clock),
    answer: (result: OpResult) => listeners.forEach((listener) => listener(result)),
    close,
  };
}

const settled = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

describe("createBoxOps", () => {
  it("answers box_stopped without sending when the box is stopped", async () => {
    for (const phase of ["stopped", "starting", "paused", "stopping"] as const) {
      const { ops, sent } = bed(phase);
      await expect(ops.call(PROJECT, STATUS)).rejects.toEqual(new PapError("box_stopped"));
      expect(sent).toEqual([]);
    }
  });

  it("matches an answer to its call by id and checks the value against the operation's schema", async () => {
    const { ops, sent, answer } = bed();
    const first = ops.call(PROJECT, STATE);
    const second = ops.call(PROJECT, STATUS);
    const [one, two] = sent;
    // Answers come out of order: each call gets its own.
    answer({ type: "op_result", id: (two as { id: string }).id, ok: false, code: "not_found" });
    answer({
      type: "op_result",
      id: (one as { id: string }).id,
      ok: true,
      value: { enabled: true, concepts: 3 },
    });
    await expect(first).resolves.toEqual({ enabled: true, concepts: 3 });
    await expect(second).rejects.toEqual(new PapError("not_found"));
  });

  it("refuses a value that is not the operation's", async () => {
    const { ops, sent, answer } = bed();
    const call = settled(ops.call(PROJECT, STATE));
    answer({ type: "op_result", id: (sent[0] as { id: string }).id, ok: true, value: { enabled: "yes" } });
    expect(await call).toEqual({ error: new PapError("worker_failed") });
  });

  it("refuses a ninth call in flight", async () => {
    const { ops, sent } = bed();
    const calls = Array.from({ length: BOX_OP_LIMITS.inFlight }, () => settled(ops.call(PROJECT, STATUS)));
    await expect(ops.call(PROJECT, STATUS)).rejects.toEqual(new PapError("capacity"));
    expect(sent).toHaveLength(BOX_OP_LIMITS.inFlight);
    void calls;
  });

  it("frees a place when a call is answered", async () => {
    const { ops, sent, answer } = bed();
    const calls = Array.from({ length: BOX_OP_LIMITS.inFlight }, () => settled(ops.call(PROJECT, STATE)));
    answer({
      type: "op_result",
      id: (sent[0] as { id: string }).id,
      ok: true,
      value: { enabled: false, concepts: 0 },
    });
    await calls[0];
    const next = settled(ops.call(PROJECT, STATE));
    expect(sent).toHaveLength(BOX_OP_LIMITS.inFlight + 1);
    void next;
  });

  it("times out after 30 s on the clock", async () => {
    const { ops, clock } = bed();
    const call = settled(ops.call(PROJECT, STATUS));
    await clock.advance(BOX_OP_LIMITS.timeoutMs - 1);
    await clock.advance(1);
    expect(await call).toEqual({ error: new PapError("timeout") });
  });

  it("fails pending calls when the link closes", async () => {
    const { ops, close } = bed();
    const calls = [settled(ops.call(PROJECT, STATUS)), settled(ops.call(PROJECT, STATE))];
    close();
    expect(await Promise.all(calls)).toEqual([
      { error: new PapError("box_stopped") },
      { error: new PapError("box_stopped") },
    ]);
  });

  it("stops waiting when the caller aborts", async () => {
    const { ops, sent } = bed();
    const controller = new AbortController();
    const call = settled(ops.call(PROJECT, STATUS, controller.signal));
    expect(sent).toHaveLength(1);
    controller.abort();
    expect(await call).toEqual({ error: new PapError("timeout") });
  });
});
