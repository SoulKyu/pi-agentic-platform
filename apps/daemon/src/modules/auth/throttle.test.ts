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
