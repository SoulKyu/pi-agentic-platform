import { describe, expect, it } from "vitest";
import { createInflight } from "./inflight.ts";

const enterAll = (inflight: ReturnType<typeof createInflight>, owner: string, times: number) =>
  Array.from({ length: times }, () => inflight.enter(owner));

describe("createInflight", () => {
  it("lets four of one owner in and refuses the fifth, never queueing it", () => {
    const inflight = createInflight(4);
    const slots = enterAll(inflight, "u1", 4);
    expect(slots.every((slot) => typeof slot === "function")).toBe(true);
    expect(inflight.enter("u1")).toBeNull();
    expect(inflight.enter("u1")).toBeNull();
  });

  it("frees a slot when one leaves", () => {
    const inflight = createInflight(4);
    const slots = enterAll(inflight, "u1", 4);
    slots[0]?.();
    const next = inflight.enter("u1");
    expect(typeof next).toBe("function");
    expect(inflight.enter("u1")).toBeNull();
  });

  it("frees one slot however often a leave is called", () => {
    const inflight = createInflight(4);
    const slots = enterAll(inflight, "u1", 4);
    slots[0]?.();
    slots[0]?.();
    slots[0]?.();
    expect(typeof inflight.enter("u1")).toBe("function");
    expect(inflight.enter("u1")).toBeNull();
  });

  it("counts each owner on its own", () => {
    const inflight = createInflight(4);
    enterAll(inflight, "u1", 4);
    expect(typeof inflight.enter("u2")).toBe("function");
  });

  it("forgets an owner once all left", () => {
    const inflight = createInflight(1);
    const leave = inflight.enter("u1");
    leave?.();
    for (let i = 0; i < 3; i++) inflight.enter(`o${i}`)?.();
    expect(typeof inflight.enter("u1")).toBe("function");
    expect(inflight.enter("u1")).toBeNull();
  });
});
