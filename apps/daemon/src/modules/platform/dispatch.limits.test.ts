import { PLATFORM_OPS } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PlatformContext, PlatformHandler } from "./index.ts";
import { createDispatchBed } from "./testing/dispatch-bed.ts";

/** A handler that never answers by itself: the test resolves it. */
function holding(bed: ReturnType<typeof createDispatchBed>) {
  const signals: AbortSignal[] = [];
  const resolvers: Array<() => void> = [];
  const handler: PlatformHandler<"agent.notify"> = (_args, ctx: PlatformContext) => {
    signals.push(ctx.signal);
    return new Promise((resolve) => resolvers.push(() => resolve({ itemId: "i1" })));
  };
  bed.port.register("agent.notify", handler);
  return { signals, resolvers };
}

const outcomes = (bed: ReturnType<typeof createDispatchBed>): Record<string, string> =>
  Object.fromEntries(bed.replies.map((r) => [r.id, r.error ?? "ok"]));

describe("calls in flight", () => {
  it("answers rate_limited to a ninth call and accepts one again once a call has ended", async () => {
    const bed = createDispatchBed();
    const { resolvers } = holding(bed);
    bed.session("s1");
    for (let i = 1; i <= 9; i++) bed.call("s1", { id: `p${i}`, op: "agent.notify" });
    expect(outcomes(bed)).toEqual({ p9: "rate_limited" });
    expect(resolvers).toHaveLength(8);
    resolvers[0]?.();
    await bed.settle();
    bed.call("s1", { id: "p10", op: "agent.notify" });
    expect(resolvers).toHaveLength(9);
    expect(outcomes(bed)).toEqual({ p1: "ok", p9: "rate_limited" });
  });

  it("counts in-flight calls per session", () => {
    const bed = createDispatchBed();
    const { resolvers } = holding(bed);
    bed.session("s1");
    bed.session("s2");
    for (let i = 1; i <= 8; i++) bed.call("s1", { id: `p${i}`, op: "agent.notify" });
    bed.call("s2", { id: "p1", op: "agent.notify" });
    expect(resolvers).toHaveLength(9);
    expect(bed.replies).toEqual([]);
  });

  it("answers bad_request to an id already in flight and leaves the first call alone", async () => {
    const bed = createDispatchBed();
    const { resolvers } = holding(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    bed.call("s1", { id: "p1", op: "agent.notify" });
    expect(outcomes(bed)).toEqual({ p1: "bad_request" });
    expect(resolvers).toHaveLength(1);
    resolvers[0]?.();
    await bed.settle();
    expect(bed.replies.map((r) => r.ok)).toEqual([false, true]);
  });

  it("lets a new worker reuse ids: calls of an earlier worker are cancelled, not counted", async () => {
    const bed = createDispatchBed();
    const { signals, resolvers } = holding(bed);
    bed.session("s1");
    const second = vi.fn(() => true);
    for (let i = 1; i <= 8; i++) bed.call("s1", { id: `p${i}`, op: "agent.notify" });
    bed.call("s1", { id: "p1", op: "agent.notify" }, second);
    await bed.settle();
    expect(signals.slice(0, 8).every((signal) => signal.aborted)).toBe(true);
    expect(resolvers).toHaveLength(9);
    expect(second).not.toHaveBeenCalled();
  });
});

describe("deadlines and cancels", () => {
  it("answers timeout when the op's deadline passes, and aborts the handler's signal", async () => {
    const bed = createDispatchBed();
    const { signals } = holding(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    await bed.clock.advance(PLATFORM_OPS["agent.notify"].deadlineMs - 1);
    expect(bed.replies).toEqual([]);
    expect(signals[0]?.aborted).toBe(false);
    await bed.clock.advance(1);
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "timeout" }]);
    expect(signals[0]?.aborted).toBe(true);
    // The reason is the code, so an op can tell a deadline from a stop (Task 29b).
    expect(signals[0]?.reason).toBe("timeout");
    expect(bed.audit[0]).toMatchObject({ decision: "block", reason: "timeout" });
  });

  it("clears the deadline when the handler answers in time, and ignores its late answer", async () => {
    const bed = createDispatchBed();
    const { resolvers } = holding(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    resolvers[0]?.();
    await bed.settle();
    expect(bed.clock.pending()).toBe(0);
    expect(bed.replies).toHaveLength(1);
    bed.call("s1", { id: "p2", op: "agent.notify" });
    await bed.clock.advance(PLATFORM_OPS["agent.notify"].deadlineMs);
    resolvers[1]?.();
    await bed.settle();
    expect(outcomes(bed)).toEqual({ p1: "ok", p2: "timeout" });
    expect(bed.audit).toHaveLength(2);
  });

  it("answers cancelled to a platform_cancel and aborts the signal", async () => {
    const bed = createDispatchBed();
    const { signals } = holding(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    bed.cancel("s1", "p1");
    await bed.settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBe("cancelled");
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "cancelled" }]);
    expect(bed.clock.pending()).toBe(0);
  });

  it("answers cancelled even to a handler that ignores its signal and rejects later", async () => {
    const bed = createDispatchBed();
    let reject: (error: Error) => void = () => {};
    bed.port.register("agent.notify", (() => new Promise((_, no) => (reject = no))) as never);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    bed.cancel("s1", "p1");
    reject(new Error("late"));
    await bed.settle();
    expect(bed.replies).toHaveLength(1);
    expect(bed.replies[0]).toMatchObject({ error: "cancelled" });
  });

  it("ignores a cancel for an id it does not know, one already answered, and another session's", async () => {
    const bed = createDispatchBed();
    const { signals, resolvers } = holding(bed);
    bed.session("s1");
    bed.session("s2");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    expect(() => bed.cancel("s1", "p9")).not.toThrow();
    expect(() => bed.cancel("ghost", "p1")).not.toThrow();
    bed.cancel("s2", "p1");
    expect(signals[0]?.aborted).toBe(false);
    resolvers[0]?.();
    await bed.settle();
    expect(() => bed.cancel("s1", "p1")).not.toThrow();
    expect(bed.replies).toHaveLength(1);
  });
});

describe("the audit slot of a call", () => {
  it("answers rate_limited and runs nothing when no slot is left, writing no row", async () => {
    let slots = 2;
    const bed = createDispatchBed({ reserve: () => slots-- > 0 });
    const { resolvers } = holding(bed);
    bed.session("s1");
    for (let i = 1; i <= 3; i++) bed.call("s1", { id: `p${i}`, op: "agent.notify" });
    expect(resolvers).toHaveLength(2);
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p3", ok: false, error: "rate_limited" }]);
    expect(bed.audit).toEqual([]);
  });

  it("holds no slot for a read-only database", () => {
    const bed = createDispatchBed({ readOnly: true, reserve: () => false });
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    expect(bed.replies[0]).toMatchObject({ error: "unavailable" });
  });
});

describe("who may cancel", () => {
  it("ignores a cancel from an earlier worker that names an id the new worker reuses", async () => {
    const bed = createDispatchBed();
    const { signals } = holding(bed);
    bed.session("s1");
    const second = vi.fn(() => true);
    bed.call("s1", { id: "p1", op: "agent.notify" });
    bed.call("s1", { id: "p1", op: "agent.notify" }, second);
    bed.cancel("s1", "p1", bed.reply);
    await bed.settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("ends the calls of a worker that is gone, and not those of another worker", async () => {
    const bed = createDispatchBed();
    const { signals } = holding(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    bed.port.workerEnded(
      { id: "s1", ownerId: "u1" },
      vi.fn(() => true),
    );
    await bed.settle();
    expect(signals[0]?.aborted).toBe(false);
    bed.port.workerEnded({ id: "s1", ownerId: "u1" }, bed.reply);
    await bed.settle();
    expect(signals[0]?.aborted).toBe(true);
  });
});
