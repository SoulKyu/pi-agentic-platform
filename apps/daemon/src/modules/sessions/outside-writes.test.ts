import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createOutsideWrites, OUTSIDE_WRITE_MS } from "./outside-writes.ts";
import { MAX_OUTSIDE_WRITES } from "./scan-port.ts";

describe("outside writes of the service (owner Q13)", () => {
  it("forgets the oldest worker end past MAX_OUTSIDE_WRITES", () => {
    const outside = createOutsideWrites(createFakeClock());
    for (let i = 0; i <= MAX_OUTSIDE_WRITES; i++) outside.workerEnded(`s${i}`);
    expect(outside.workerEndedAt("s0")).toBeNull();
    expect(outside.workerEndedAt("s1")).not.toBeNull();
    expect(outside.workerEndedAt(`s${MAX_OUTSIDE_WRITES}`)).not.toBeNull();
  });

  it("calls a write recent for exactly 2 minutes", () => {
    const clock = createFakeClock();
    const outside = createOutsideWrites(clock);
    const at = clock.now();
    expect(outside.recent(null)).toBe(false);
    expect(outside.recent(at - OUTSIDE_WRITE_MS)).toBe(true);
    expect(outside.recent(at - OUTSIDE_WRITE_MS - 1)).toBe(false);
  });
});

describe("pap's last write is kept (MC19 a)", () => {
  it("hands every worker end to the persist callback with the clock's time", () => {
    const clock = createFakeClock();
    const stamps: Array<[string, number]> = [];
    const outside = createOutsideWrites(clock, (id, at) => void stamps.push([id, at]));
    outside.workerEnded("s1");
    expect(stamps).toEqual([["s1", clock.now()]]);
  });
});
