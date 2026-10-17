import {
  PLATFORM_OP_NAMES,
  PLATFORM_OPS,
  type PlatformOp,
  SESSION_TYPES,
  type SessionType,
} from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { PlatformRefusal } from "./index.ts";
import { ARGS, createDispatchBed, outcomes, registerAll, RESULTS } from "./testing/dispatch-bed.ts";

/** Written out from the table of the plan (§ "Session types and platform ops at a glance"), not read from the contract. */
const ALLOWED: Record<PlatformOp, readonly SessionType[]> = {
  "agent.notify": ["agent-thread"],
  "agent.approve": ["agent-thread"],
  "agent.delegate": ["agent-thread"],
  "agent.remind": ["agent-thread"],
  "lane.note": ["lane"],
  "secret.request": ["agent-thread"],
  "network.request": ["agent-thread"],
  "subagent.run": ["plain", "lane", "agent-thread"],
};

describe("every op for every session type", () => {
  for (const type of SESSION_TYPES) {
    describe(`a ${type} session`, () => {
      for (const op of PLATFORM_OP_NAMES) {
        const allowed = ALLOWED[op].includes(type);
        it(`${allowed ? "runs" : "refuses"} ${op}`, async () => {
          const bed = createDispatchBed();
          const handlers = registerAll(bed);
          bed.session("s1", { type });
          bed.call("s1", { id: "p1", op });
          await bed.settle();
          if (allowed) {
            expect(handlers[op]).toHaveBeenCalledTimes(1);
            expect(bed.replies).toEqual([
              { type: "platform_result", id: "p1", ok: true, result: RESULTS[op] },
            ]);
          } else {
            expect(handlers[op]).not.toHaveBeenCalled();
            expect(bed.replies).toEqual([
              { type: "platform_result", id: "p1", ok: false, error: "forbidden" },
            ]);
          }
          expect(bed.audit).toHaveLength(1);
          expect(bed.audit[0]).toMatchObject({
            decision: allowed ? "allow" : "block",
            reason: allowed ? "ok" : "forbidden",
          });
        });
      }
    });
  }

  it("matches the contract's table", () => {
    for (const op of PLATFORM_OP_NAMES) expect([...PLATFORM_OPS[op].callers]).toEqual(ALLOWED[op]);
  });
});

describe("the caller is the session's row, never the worker's word", () => {
  it("refuses a plain session whose record claims to come from an agent thread", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1", { type: "plain", agentId: null });
    bed.call("s1", {
      id: "p1",
      op: "agent.delegate",
      sessionType: "agent-thread",
      agentId: "atlas-0001",
    } as never);
    bed.call("s1", { id: "p2", op: "agent.notify", args: { text: "x", type: "agent-thread" } });
    await bed.settle();
    expect(bed.replies.map((r) => r.error)).toEqual(["forbidden", "forbidden"]);
    expect(handlers["agent.delegate"]).not.toHaveBeenCalled();
    expect(handlers["agent.notify"]).not.toHaveBeenCalled();
  });

  it("reads the type at the call, so a session that became a child loses its ops", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1", { type: "agent-thread" });
    bed.call("s1", { id: "p1", op: "agent.notify" });
    bed.session("s1", { type: "child" });
    bed.call("s1", { id: "p2", op: "agent.notify" });
    await bed.settle();
    expect(handlers["agent.notify"]).toHaveBeenCalledTimes(1);
    expect(outcomes(bed)).toEqual({ p1: "ok", p2: "forbidden" });
  });

  it("starts the handler in the same tick as the row read: nothing is awaited in between", () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    expect(handlers["agent.notify"]).toHaveBeenCalledTimes(1);
  });

  it("gives the handler the row's owner, type, taint and agent, and a live signal", async () => {
    const bed = createDispatchBed();
    const seen: unknown[] = [];
    bed.port.register("agent.notify", ((_args: unknown, ctx: { signal: AbortSignal }) => {
      seen.push({ ...ctx, signal: ctx.signal.aborted });
      return Promise.resolve(RESULTS["agent.notify"]);
    }) as never);
    bed.session("s1", { ownerId: "u9", agentId: "atlas-0001", tainted: true });
    bed.port.onRecord(
      { id: "s1", ownerId: "someone-else" },
      { type: "platform_call", id: "p1", op: "agent.notify", toolCallId: "tc1", args: ARGS["agent.notify"] },
      bed.reply,
    );
    await bed.settle();
    expect(seen).toEqual([
      {
        ownerId: "u9",
        sessionId: "s1",
        type: "agent-thread",
        tainted: true,
        agentId: "atlas-0001",
        signal: false,
      },
    ]);
  });

  it("refuses an op name that is not in the table and a malformed record", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "constructor" as never });
    bed.call("s1", { id: "p2", op: "agent.notify", toolCallId: "t".repeat(257) });
    bed.call("s1", { id: "p3", op: "agent.notify", toolCallId: 5 as never });
    await bed.settle();
    expect(bed.replies.map((r) => r.error)).toEqual(["bad_request", "bad_request", "bad_request"]);
    expect(handlers["agent.notify"]).not.toHaveBeenCalled();
  });
});

describe("a tainted caller", () => {
  it("runs an op that runs when tainted", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1", { tainted: true });
    bed.call("s1", { id: "p1", op: "agent.notify" });
    await bed.settle();
    expect(handlers["agent.notify"]).toHaveBeenCalledTimes(1);
  });

  it("answers tainted to agent.delegate without an approved call, runs it with one, and spends it", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1", { tainted: true });
    bed.call("s1", { id: "p1", op: "agent.delegate" });
    expect(handlers["agent.delegate"]).not.toHaveBeenCalled();
    bed.approve("s1", "tc1", "agent_delegate");
    bed.call("s1", { id: "p2", op: "agent.delegate" });
    bed.call("s1", { id: "p3", op: "agent.delegate" });
    await bed.settle();
    expect(handlers["agent.delegate"]).toHaveBeenCalledTimes(1);
    expect(outcomes(bed)).toEqual({ p1: "tainted", p2: "ok", p3: "tainted" });
  });

  it("does not spend an approval noted for another tool call", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1", { tainted: true });
    bed.approve("s1", "tc-other", "agent_delegate");
    bed.call("s1", { id: "p1", op: "agent.delegate", toolCallId: "tc1" });
    await bed.settle();
    expect(handlers["agent.delegate"]).not.toHaveBeenCalled();
    expect(bed.replies[0]).toMatchObject({ error: "tainted" });
  });

  it("answers tainted when the approval was given for the bash tool, and keeps it for the bash card", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1", { tainted: true });
    bed.approve("s1", "tc1", "bash");
    bed.call("s1", { id: "p1", op: "agent.delegate" });
    await bed.settle();
    expect(handlers["agent.delegate"]).not.toHaveBeenCalled();
    expect(bed.replies[0]).toMatchObject({ ok: false, error: "tainted" });
    expect(bed.approvals.size).toBe(1);
  });

  it("asks for agent.remind the same way", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1", { tainted: true });
    bed.call("s1", { id: "p1", op: "agent.remind" });
    bed.approve("s1", "tc2", "agent_remind");
    bed.call("s1", { id: "p2", op: "agent.remind", toolCallId: "tc2" });
    await bed.settle();
    expect(outcomes(bed)).toEqual({ p1: "tainted", p2: "ok" });
    expect(handlers["agent.remind"]).toHaveBeenCalledTimes(1);
  });

  it("does not spend an approval on a caller its type refuses", async () => {
    const bed = createDispatchBed();
    registerAll(bed);
    bed.session("s1", { type: "plain", tainted: true, agentId: null });
    bed.approve("s1", "tc1", "agent_delegate");
    bed.call("s1", { id: "p1", op: "agent.delegate" });
    await bed.settle();
    expect(bed.replies[0]).toMatchObject({ error: "forbidden" });
    expect(bed.approvals.size).toBe(1);
  });
});

describe("availability and arguments", () => {
  it("answers unavailable for an op with no handler", async () => {
    const bed = createDispatchBed();
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    await bed.settle();
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "unavailable" }]);
  });

  it("answers unavailable for an op whose switch is off, and again once it is on", async () => {
    const bed = createDispatchBed();
    let on = false;
    const handler = vi.fn(() => Promise.resolve(RESULTS["subagent.run"]));
    bed.port.register("subagent.run", handler as never, { enabled: () => on });
    bed.session("s1", { type: "plain", agentId: null });
    bed.call("s1", { id: "p1", op: "subagent.run" });
    on = true;
    bed.call("s1", { id: "p2", op: "subagent.run" });
    await bed.settle();
    expect(outcomes(bed)).toEqual({ p1: "unavailable", p2: "ok" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("answers bad_request before the handler for arguments the schema refuses, extra keys included", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify", args: {} });
    bed.call("s1", { id: "p2", op: "agent.notify", args: { text: "x", extra: 1 } });
    bed.call("s1", { id: "p3", op: "agent.notify", args: undefined });
    await bed.settle();
    expect(bed.replies.map((r) => r.error)).toEqual(["bad_request", "bad_request", "bad_request"]);
    expect(handlers["agent.notify"]).not.toHaveBeenCalled();
  });

  it("answers bad_request for arguments over 64 KiB of JSON", async () => {
    const bed = createDispatchBed();
    const handlers = registerAll(bed);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify", args: { text: "x".repeat(70 * 1024) } });
    bed.call("s1", { id: "p2", op: "agent.notify", args: { text: "é".repeat(40 * 1024) } });
    await bed.settle();
    expect(bed.replies.map((r) => r.error)).toEqual(["bad_request", "bad_request"]);
    expect(handlers["agent.notify"]).not.toHaveBeenCalled();
  });
});

describe("an oversized call", () => {
  it("is refused before the session is read, so even a gone session's worker is told", () => {
    const bed = createDispatchBed();
    registerAll(bed);
    bed.call("ghost", { id: "p1", op: "agent.notify", args: { text: "x".repeat(70 * 1024) } });
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "bad_request" }]);
  });
});

describe("what a handler does", () => {
  it("answers with the code of a PlatformRefusal", async () => {
    const bed = createDispatchBed();
    bed.port.register("agent.notify", (() => Promise.reject(new PlatformRefusal("limit_reached"))) as never);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    await bed.settle();
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "limit_reached" }]);
    expect(bed.audit[0]).toMatchObject({ decision: "block", reason: "limit_reached" });
  });

  it("answers internal for any other throw and logs the op and the error class only", async () => {
    const bed = createDispatchBed();
    bed.port.register("agent.notify", (() => {
      throw new RangeError("secret-token-ghp_abcdef");
    }) as never);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    await bed.settle();
    expect(bed.replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "internal" }]);
    const line = bed.lines.find((entry) => entry.msg === "platform_op_failed");
    expect(line).toMatchObject({ op: "agent.notify", errorClass: "RangeError" });
    expect(JSON.stringify(bed.lines)).not.toContain("secret-token");
    expect(JSON.stringify(bed.audit)).not.toContain("secret-token");
  });

  it("answers internal for a result the op's schema refuses, extra keys included", async () => {
    const bed = createDispatchBed();
    bed.port.register("agent.notify", (() => Promise.resolve({ itemId: 5 })) as never);
    bed.port.register("agent.approve", (() => Promise.resolve({ approved: true, leak: "x" })) as never);
    bed.session("s1");
    bed.call("s1", { id: "p1", op: "agent.notify" });
    bed.call("s1", { id: "p2", op: "agent.approve" });
    await bed.settle();
    expect(bed.replies.map((r) => [r.error, r.result])).toEqual([
      ["internal", undefined],
      ["internal", undefined],
    ]);
    expect(bed.lines.filter((entry) => entry.msg === "platform_result_invalid")).toHaveLength(2);
  });
});
