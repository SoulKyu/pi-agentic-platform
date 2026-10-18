import { describe, expect, it } from "vitest";
import { createSteppableClock, PARKED_FROM_MS } from "./steppable-clock.ts";

const FIVE_MINUTES = 5 * 60_000;

describe("the steppable clock", () => {
  it("leaves a timer under a minute on the real clock: advance does not run it", async () => {
    const clock = createSteppableClock();
    let ran = false;
    const handle = clock.setTimeout(() => (ran = true), PARKED_FROM_MS - 1);
    await clock.advance(FIVE_MINUTES);
    expect(ran).toBe(false);
    clock.clearTimeout(handle);
  });

  it("runs a parked timer when advance passes it", async () => {
    const clock = createSteppableClock();
    let ran = false;
    clock.setTimeout(() => (ran = true), PARKED_FROM_MS);
    await clock.advance(PARKED_FROM_MS);
    expect(ran).toBe(true);
  });

  it("aligns to the next period boundary, so a period-long wait is parked", async () => {
    const clock = createSteppableClock();
    await clock.advance(1_234);
    await clock.alignTo(FIVE_MINUTES);
    expect(clock.now() % FIVE_MINUTES).toBeLessThan(1_000);
    await clock.alignTo(FIVE_MINUTES);
    expect(clock.now() % FIVE_MINUTES).toBeLessThan(1_000);
  });
});
