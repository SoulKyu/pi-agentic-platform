import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { BACKGROUND_RELEASE_MS, createIdleRelease, type IdleState } from "./idle-release.ts";

const THIRTY_MINUTES = 30 * 60_000;

describe("createIdleRelease", () => {
  it("releases a quiet session after idleMs, and re-arms on activity or when busy", async () => {
    const clock = createFakeClock();
    let state: IdleState = "quiet";
    const released: number[] = [];
    const idle = createIdleRelease({
      clock,
      idleMs: 1000,
      state: () => state,
      release: () => void released.push(clock.now()),
    });
    const start = clock.now();
    idle.touch();
    await clock.advance(600);
    idle.touch();
    await clock.advance(999);
    expect(released).toEqual([]);
    state = "busy";
    await clock.advance(1);
    expect(released).toEqual([]);
    state = "quiet";
    await clock.advance(1000);
    expect(released).toEqual([start + 2600]);
    idle.stop();
    expect(clock.pending()).toBe(0);
  });

  it("does not arm a timer for every touch of a busy stream", async () => {
    const clock = createFakeClock();
    const idle = createIdleRelease({ clock, idleMs: 1000, state: () => "quiet", release: () => {} });
    idle.touch();
    for (let i = 0; i < 500; i++) {
      await clock.advance(1);
      idle.touch();
    }
    expect(clock.pending()).toBe(1);
    idle.stop();
  });

  it("does nothing when disabled", async () => {
    const clock = createFakeClock();
    for (const idleMs of [0, -1]) {
      const idle = createIdleRelease({
        clock,
        idleMs,
        state: () => "quiet",
        release: () => {
          throw new Error("released");
        },
      });
      idle.touch();
      expect(clock.pending()).toBe(0);
      await clock.advance(10 * THIRTY_MINUTES);
    }
  });

  it("keeps a worker whose agent left processes running, and releases it anyway 8 h after its last activity (owner R2-2)", async () => {
    const clock = createFakeClock();
    const released: number[] = [];
    const idle = createIdleRelease({
      clock,
      idleMs: THIRTY_MINUTES,
      state: () => "background",
      release: () => void released.push(clock.now()),
    });
    const start = clock.now();
    idle.touch();
    await clock.advance(BACKGROUND_RELEASE_MS - 1);
    expect(released).toEqual([]);
    await clock.advance(1);
    expect(released).toEqual([start + BACKGROUND_RELEASE_MS]);
    expect(BACKGROUND_RELEASE_MS).toBe(8 * 60 * 60_000);
  });

  it("releases at the 8 h boundary whatever idleMs divides, counted from the last activity", async () => {
    const clock = createFakeClock();
    const released: number[] = [];
    const idle = createIdleRelease({
      clock,
      idleMs: 7 * 60_000,
      state: () => "background",
      release: () => void released.push(clock.now()),
    });
    idle.touch();
    await clock.advance(60_000);
    const start = clock.now();
    idle.touch();
    await clock.advance(BACKGROUND_RELEASE_MS - 1);
    expect(released).toEqual([]);
    await clock.advance(1);
    expect(released).toEqual([start + BACKGROUND_RELEASE_MS]);
  });

  it("a quiet session whose agent processes ended is released at the next expiry", async () => {
    const clock = createFakeClock();
    let state: IdleState = "background";
    const released: number[] = [];
    const idle = createIdleRelease({
      clock,
      idleMs: 1000,
      state: () => state,
      release: () => void released.push(clock.now()),
    });
    idle.touch();
    await clock.advance(5000);
    expect(released).toEqual([]);
    state = "quiet";
    await clock.advance(1000);
    expect(released).toHaveLength(1);
  });

  it("stop() clears the timer and later touches arm nothing; it releases once", async () => {
    const clock = createFakeClock();
    const released: number[] = [];
    const idle = createIdleRelease({
      clock,
      idleMs: 1000,
      state: () => "quiet",
      release: () => void released.push(1),
    });
    idle.touch();
    idle.stop();
    expect(clock.pending()).toBe(0);
    idle.touch();
    expect(clock.pending()).toBe(0);
    await clock.advance(5000);
    expect(released).toEqual([]);
    const again = createIdleRelease({
      clock,
      idleMs: 1000,
      state: () => "quiet",
      release: () => void released.push(1),
    });
    again.touch();
    await clock.advance(10_000);
    expect(released).toEqual([1]);
    expect(clock.pending()).toBe(0);
  });
});
