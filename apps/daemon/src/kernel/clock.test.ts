import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock.ts";

describe("fake clock", () => {
  it("runs due timers in time order and moves now", async () => {
    const clock = createFakeClock(1000);
    const calls: string[] = [];
    clock.setTimeout(() => calls.push("b@300"), 300);
    clock.setTimeout(() => calls.push("a@100"), 100);
    await clock.advance(200);
    expect(calls).toEqual(["a@100"]);
    expect(clock.now()).toBe(1200);
    await clock.advance(100);
    expect(calls).toEqual(["a@100", "b@300"]);
  });

  it("resolves sleep and runs timers scheduled by timers", async () => {
    const clock = createFakeClock();
    let woke = false;
    void clock
      .sleep(50)
      .then(() => clock.sleep(50))
      .then(() => {
        woke = true;
      });
    await clock.advance(100);
    expect(woke).toBe(true);
  });

  it("forgets cleared timers", async () => {
    const clock = createFakeClock();
    let fired = false;
    clock.clearTimeout(
      clock.setTimeout(() => {
        fired = true;
      }, 10),
    );
    await clock.advance(20);
    expect(fired).toBe(false);
    expect(clock.pending()).toBe(0);
  });
});
