import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createThrottle } from "./throttle.ts";

describe("login throttle", () => {
  it("doubles the wait per failure up to 60 s and takes the max over keys", () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock);
    throttle.fail(["ip:a", "user:owner"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(1000);
    throttle.fail(["user:owner"]);
    expect(throttle.retryAfterMs(["ip:b", "user:owner"])).toBe(2000);
    for (let i = 0; i < 10; i++) throttle.fail(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(60_000);
  });

  it("counts down with the clock", async () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock);
    throttle.fail(["ip:a"]);
    await clock.advance(400);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(600);
    await clock.advance(600);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(0);
  });

  it("forgets a key after five idle minutes and on success", async () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock);
    throttle.fail(["ip:a"]);
    await clock.advance(5 * 60_000);
    throttle.fail(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(1000);
    throttle.succeed(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(0);
  });
});

describe("login throttle bound", () => {
  it("never holds more than 10 000 live keys: the oldest failure goes first", () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock);
    for (let i = 0; i < 10_000; i++) throttle.fail([`ip:${i}`]);
    expect(throttle.retryAfterMs(["ip:0"])).toBe(1000);
    throttle.fail(["ip:new"]);
    throttle.fail(["ip:newer"]);
    expect(throttle.size()).toBe(10_000);
    expect(throttle.retryAfterMs(["ip:0"])).toBe(0);
    expect(throttle.retryAfterMs(["ip:1"])).toBe(0);
    expect(throttle.retryAfterMs(["ip:2"])).toBe(1000);
    expect(throttle.retryAfterMs(["ip:newer"])).toBe(1000);
  });
});
