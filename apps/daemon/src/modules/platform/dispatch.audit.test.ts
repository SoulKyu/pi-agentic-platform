import { describe, expect, it } from "vitest";
import { createDispatchBed, outcomes, registerAll } from "./testing/dispatch-bed.ts";

describe("read-only mode and shutdown", () => {
  it("answers unavailable in read-only mode and writes nothing", async () => {
    const bed = createDispatchBed({ readOnly: true });
    const handlers = registerAll(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    await bed.settle();
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "unavailable" }]);
    expect(handlers["agent.notify"]).not.toHaveBeenCalled();
    expect(bed.audit).toEqual([]);
  });

  it("stops accepting calls and ends the ones in flight with unavailable", async () => {
    const bed = createDispatchBed();
    let signal: AbortSignal | undefined;
    bed.port.register("agent.approve", ((_args: unknown, ctx: { signal: AbortSignal }) => {
      signal = ctx.signal;
      return new Promise(() => {});
    }) as never);
    registerAll(bed, "agent.approve");
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.approve" });
    bed.port.stop();
    bed.call("s1", { id: "p2", op: "agent.notify" });
    await bed.settle();
    expect(signal?.aborted).toBe(true);
    expect(outcomes(bed)).toEqual({ p1: "unavailable", p2: "unavailable" });
  });
});

describe("one audit row per call", () => {
  it("records the op, the type and the code, never the arguments or the result", async () => {
    const bed = createDispatchBed();
    registerAll(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify", args: { text: "hunter2-in-the-text" } });
    bed.call("s1", { id: "p2", op: "agent.approve", args: { nope: "hunter2-too" } });
    bed.call("s1", { id: "p3", op: "lane.note", args: { note: "hunter2-three" } });
    await bed.settle();
    expect(bed.audit).toEqual([
      {
        ownerId: "u1",
        actor: "worker",
        kind: "policy",
        sessionId: "s1",
        tool: "agent.approve",
        decision: "block",
        reason: "bad_request",
        detail: { op: "agent.approve", type: "agent-thread", code: "bad_request" },
      },
      {
        ownerId: "u1",
        actor: "worker",
        kind: "policy",
        sessionId: "s1",
        tool: "lane.note",
        decision: "block",
        reason: "forbidden",
        detail: { op: "lane.note", type: "agent-thread", code: "forbidden" },
      },
      {
        ownerId: "u1",
        actor: "worker",
        kind: "policy",
        sessionId: "s1",
        tool: "agent.notify",
        decision: "allow",
        reason: "ok",
        detail: { op: "agent.notify", type: "agent-thread", code: "ok" },
      },
    ]);
    expect(JSON.stringify(bed.audit)).not.toContain("hunter2");
  });
});

describe("a call from a session whose row is gone", () => {
  it("answers not_found at once, runs nothing and leaves one block row", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.call("ghost", { id: "p1", op: "agent.notify" });
    await bed.settle();
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "not_found" }]);
    expect(handlers["agent.notify"]).not.toHaveBeenCalled();
    expect(bed.audit).toMatchObject([
      { sessionId: "ghost", tool: "agent.notify", decision: "block", reason: "not_found" },
    ]);
  });
});
