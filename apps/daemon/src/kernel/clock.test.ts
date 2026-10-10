import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, createSystemClock, MAX_TIMER_MS } from "./clock.ts";

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

describe("fake clock with long delays", () => {
  it("does not fire a delay above 2^31 - 1 ms early", async () => {
    const clock = createFakeClock(0);
    let fired = false;
    clock.setTimeout(
      () => {
        fired = true;
      },
      2 ** 31 + 1000,
    );
    await clock.advance(1);
    expect(fired).toBe(false);
    await clock.advance(2 ** 31);
    expect(fired).toBe(false);
    await clock.advance(999);
    expect(fired).toBe(true);
  });
});

interface ArmedTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  unref(): ArmedTimer;
}

// Replaces the global timers with recorders so a test can see each hop and fire it by hand.
function recordTimers(): ArmedTimer[] {
  const armed: ArmedTimer[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
    const timer: ArmedTimer = { fn, ms, cleared: false, unref: () => timer };
    armed.push(timer);
    return timer;
  }) as unknown as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((timer: ArmedTimer) => {
    timer.cleared = true;
  }) as unknown as typeof clearTimeout);
  return armed;
}

describe("system clock", () => {
  afterEach(() => vi.restoreAllMocks());

  it("chains timers so a delay above 2^31 - 1 ms is not clamped to 1 ms", () => {
    const armed = recordTimers();
    const clock = createSystemClock();
    let fired = 0;
    clock.setTimeout(() => fired++, 2 * MAX_TIMER_MS + 5000);

    expect(armed.map((timer) => timer.ms)).toEqual([MAX_TIMER_MS]);
    armed[0]?.fn();
    expect(armed.map((timer) => timer.ms)).toEqual([MAX_TIMER_MS, MAX_TIMER_MS]);
    armed[1]?.fn();
    expect(armed.map((timer) => timer.ms)).toEqual([MAX_TIMER_MS, MAX_TIMER_MS, 5000]);
    expect(fired).toBe(0);
    armed[2]?.fn();
    expect(fired).toBe(1);
  });

  it("arms a delay at the limit in one hop", () => {
    const armed = recordTimers();
    const clock = createSystemClock();
    clock.setTimeout(() => {}, MAX_TIMER_MS);
    expect(armed.map((timer) => timer.ms)).toEqual([MAX_TIMER_MS]);
  });

  it("clears the hop that is currently armed", () => {
    const armed = recordTimers();
    const clock = createSystemClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, MAX_TIMER_MS + 10);
    armed[0]?.fn();
    clock.clearTimeout(handle);
    expect(armed[1]?.cleared).toBe(true);
    expect(fired).toBe(false);
  });
});

describe("system clock on real timers", () => {
  it("still runs a short sleep", async () => {
    const clock = createSystemClock();
    const before = clock.now();
    await clock.sleep(15);
    expect(clock.now() - before).toBeGreaterThanOrEqual(10);
  });
});
