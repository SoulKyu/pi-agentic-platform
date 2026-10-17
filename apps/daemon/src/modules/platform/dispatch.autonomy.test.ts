import { describe, expect, it } from "vitest";
import { createDispatchBed, outcomes, registerAll } from "./testing/dispatch-bed.ts";

const OPS = ["agent.remind", "agent.delegate"] as const;

describe("a tainted remind or delegate with trusted autonomy (owner a6 ii)", () => {
  for (const op of OPS) {
    it(`runs ${op} for an autonomous thread, marks the row relaxed and spends no approval`, async () => {
      const bed = createDispatchBed();
      const handlers = registerAll(bed);
      bed.session("s1", { tainted: true, autonomous: true });
      bed.approve("s1", "other-call", "unrelated");
      bed.call("s1", { id: "p1", op });
      await bed.settle();
      expect(handlers[op]).toHaveBeenCalledTimes(1);
      expect(outcomes(bed)).toEqual({ p1: "ok" });
      expect(bed.audit).toHaveLength(1);
      expect(bed.audit[0]).toMatchObject({
        decision: "allow",
        detail: { op, code: "ok", relaxed: "autonomy" },
      });
      expect(bed.approvals.size).toBe(1);
    });

    it(`answers tainted for ${op} without autonomy, and the row is not relaxed`, async () => {
      const bed = createDispatchBed();
      const handlers = registerAll(bed);
      bed.session("s1", { tainted: true });
      bed.call("s1", { id: "p1", op });
      await bed.settle();
      expect(handlers[op]).not.toHaveBeenCalled();
      expect(outcomes(bed)).toEqual({ p1: "tainted" });
      expect(bed.audit[0]?.detail).not.toHaveProperty("relaxed");
    });

    it(`spends the approval and leaves the row unrelaxed for ${op} when both hold`, async () => {
      const bed = createDispatchBed();
      registerAll(bed);
      bed.session("s1", { tainted: true, autonomous: true });
      bed.approve("s1", "tc1", op === "agent.remind" ? "agent_remind" : "agent_delegate");
      bed.call("s1", { id: "p1", op });
      await bed.settle();
      expect(outcomes(bed)).toEqual({ p1: "ok" });
      expect(bed.approvals.size).toBe(0);
      expect(bed.audit[0]?.detail).not.toHaveProperty("relaxed");
    });

    it(`does not relax an untainted ${op}`, async () => {
      const bed = createDispatchBed();
      registerAll(bed);
      bed.session("s1", { autonomous: true });
      bed.call("s1", { id: "p1", op });
      await bed.settle();
      expect(bed.audit[0]?.detail).not.toHaveProperty("relaxed");
    });

    it(`stays forbidden for an isolated task claiming autonomy (${op})`, async () => {
      const bed = createDispatchBed();
      registerAll(bed);
      bed.session("s1", { type: "agent-task", tainted: true, autonomous: true });
      bed.call("s1", { id: "p1", op });
      await bed.settle();
      expect(outcomes(bed)).toEqual({ p1: "forbidden" });
    });
  }
});
