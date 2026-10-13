import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { testCaller } from "../../testing/caller.ts";
import { createStepUps, requireStepUp } from "./step-up.ts";

describe("step-up marks", () => {
  it("marks a session for five minutes and forgets it", () => {
    const clock = createFakeClock();
    const stepUps = createStepUps(clock);
    expect(stepUps.until("a")).toBe(0);
    stepUps.mark("a");
    expect(stepUps.until("a")).toBe(clock.now() + 300_000);
    stepUps.forget("a");
    expect(stepUps.until("a")).toBe(0);
  });

  it("drops the oldest mark at the 1 025th", () => {
    const stepUps = createStepUps(createFakeClock());
    for (let i = 0; i < 1024; i++) stepUps.mark(`s${i}`);
    expect(stepUps.size()).toBe(1024);
    stepUps.mark("s1024");
    expect(stepUps.size()).toBe(1024);
    expect(stepUps.until("s0")).toBe(0);
    expect(stepUps.until("s1")).not.toBe(0);
    expect(stepUps.until("s1024")).not.toBe(0);
  });

  it("a second mark of the same session renews it and moves it to the newest", async () => {
    const clock = createFakeClock();
    const stepUps = createStepUps(clock);
    stepUps.mark("a");
    await clock.advance(1000);
    stepUps.mark("a");
    expect(stepUps.size()).toBe(1);
    expect(stepUps.until("a")).toBe(clock.now() + 300_000);
  });
});

describe("requireStepUp", () => {
  const now = 1_000_000;
  it("passes a session caller whose mark is still in the future", () => {
    expect(() => requireStepUp(testCaller({ stepUpUntil: now + 1 }), now)).not.toThrow();
  });

  it("refuses no mark, an expired mark and any token caller", () => {
    for (const caller of [
      testCaller(),
      testCaller({ stepUpUntil: now }),
      testCaller({ kind: "token", stepUpUntil: now + 60_000 }),
    ]) {
      expect(() => requireStepUp(caller, now)).toThrow(PapError);
      try {
        requireStepUp(caller, now);
      } catch (error) {
        expect((error as PapError).code).toBe("step_up_required");
      }
    }
  });
});
