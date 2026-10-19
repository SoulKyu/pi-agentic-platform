import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { CRASH_WINDOW_MS, createCrashLog, createIdleStop, fitsCapacity } from "./lifecycle.ts";

describe("createCrashLog (RT-40)", () => {
  it("reports the third crash within ten minutes", async () => {
    const clock = createFakeClock();
    const log = createCrashLog(clock);
    expect(log.record("a")).toBe(false);
    await clock.advance(60_000);
    expect(log.record("a")).toBe(false);
    await clock.advance(60_000);
    expect(log.record("a")).toBe(true);
  });
  it("forgets a crash older than the window", async () => {
    const clock = createFakeClock();
    const log = createCrashLog(clock);
    log.record("a");
    log.record("a");
    await clock.advance(CRASH_WINDOW_MS);
    expect(log.record("a")).toBe(false);
  });
  it("counts each agent apart and clears on Resume", () => {
    const log = createCrashLog(createFakeClock());
    log.record("a");
    log.record("a");
    expect(log.record("b")).toBe(false);
    log.clear("a");
    expect(log.record("a")).toBe(false);
  });
});

describe("fitsCapacity (R29)", () => {
  it("counts each VM as memory plus 512", () => {
    expect(fitsCapacity([], 1024, 1536)).toBe(true);
    expect(fitsCapacity([], 1025, 1536)).toBe(false);
    expect(fitsCapacity([1024], 1024, 3072)).toBe(true);
    expect(fitsCapacity([1024], 1024, 3071)).toBe(false);
  });
});

describe("createIdleStop", () => {
  it("fires idleMs after the last worker left, not before", async () => {
    const clock = createFakeClock();
    const onIdle = vi.fn();
    const idle = createIdleStop(clock, 1000, onIdle);
    idle.workerStarted();
    idle.workerEnded();
    await clock.advance(999);
    expect(onIdle).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
  it("never fires while a worker lives, and a new worker cancels the timer", async () => {
    const clock = createFakeClock();
    const onIdle = vi.fn();
    const idle = createIdleStop(clock, 1000, onIdle);
    idle.workerStarted();
    idle.workerStarted();
    idle.workerEnded();
    await clock.advance(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    idle.workerEnded();
    await clock.advance(500);
    idle.workerStarted();
    await clock.advance(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    expect(idle.live).toBe(1);
  });
  it("is off at 0 and arms an empty VM", async () => {
    const clock = createFakeClock();
    const never = vi.fn();
    const off = createIdleStop(clock, 0, never);
    off.armIfEmpty();
    await clock.advance(1e9);
    expect(never).not.toHaveBeenCalled();
    const onIdle = vi.fn();
    createIdleStop(clock, 5, onIdle).armIfEmpty();
    await clock.advance(5);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
