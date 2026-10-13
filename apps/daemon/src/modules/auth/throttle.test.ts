import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createAuthThrottles, createThrottle } from "./throttle.ts";

describe("login throttle", () => {
  it("doubles the wait per failure up to 60 s and takes the max over keys", () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock, { whenFull: "refuse" });
    throttle.fail(["ip:a", "user:owner"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(1000);
    throttle.fail(["user:owner"]);
    expect(throttle.retryAfterMs(["ip:b", "user:owner"])).toBe(2000);
    for (let i = 0; i < 10; i++) throttle.fail(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(60_000);
  });

  it("counts down with the clock", async () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock, { whenFull: "refuse" });
    throttle.fail(["ip:a"]);
    await clock.advance(400);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(600);
    await clock.advance(600);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(0);
  });

  it("forgets a key after five idle minutes and on success", async () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock, { whenFull: "refuse" });
    throttle.fail(["ip:a"]);
    await clock.advance(5 * 60_000);
    throttle.fail(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(1000);
    throttle.succeed(["ip:a"]);
    expect(throttle.retryAfterMs(["ip:a"])).toBe(0);
  });
});

describe("login throttle bound", () => {
  const fill = (throttle: ReturnType<typeof createThrottle>) => {
    for (let i = 0; i < 10_000; i++) throttle.fail([`ip:${i}`]);
  };

  it("refuse: keeps every live lockout, records nothing new and says so", () => {
    const throttle = createThrottle(createFakeClock(), { whenFull: "refuse" });
    for (let i = 0; i < 10; i++) throttle.fail(["user:owner"]);
    for (let i = 0; i < 9_999; i++) throttle.fail([`ip:${i}`]);
    expect(throttle.size()).toBe(10_000);
    expect(throttle.fail(["ip:new"])).toBe(false);
    expect(throttle.fail(["ip:a", "ip:b"])).toBe(false);
    expect(throttle.size()).toBe(10_000);
    expect(throttle.retryAfterMs(["user:owner"])).toBe(60_000);
    expect(throttle.retryAfterMs(["ip:0"])).toBe(1000);
    expect(throttle.retryAfterMs(["ip:new"])).toBe(0);
    expect(throttle.fail(["ip:0"])).toBe(true);
    expect(throttle.retryAfterMs(["ip:0"])).toBe(2000);
  });

  it("refuse: expired entries at the head make room again", async () => {
    const clock = createFakeClock();
    const throttle = createThrottle(clock, { whenFull: "refuse" });
    fill(throttle);
    await clock.advance(5 * 60_000);
    expect(throttle.fail(["ip:new"])).toBe(true);
    expect(throttle.size()).toBe(1);
  });

  it("evict: drops the oldest failure, never grows past the cap", () => {
    const throttle = createThrottle(createFakeClock(), { whenFull: "evict" });
    fill(throttle);
    expect(throttle.fail(["ip:new"])).toBe(true);
    expect(throttle.fail(["ip:newer"])).toBe(true);
    expect(throttle.size()).toBe(10_000);
    expect(throttle.retryAfterMs(["ip:0"])).toBe(0);
    expect(throttle.retryAfterMs(["ip:1"])).toBe(0);
    expect(throttle.retryAfterMs(["ip:2"])).toBe(1000);
    expect(throttle.retryAfterMs(["ip:newer"])).toBe(1000);
  });
});

describe("the auth throttle tables", () => {
  it("are three distinct instances: password and session refuse when full, passkey evicts", () => {
    const tables = createAuthThrottles(createFakeClock());
    expect(new Set(Object.values(tables)).size).toBe(3);
    for (const [name, table] of Object.entries(tables)) {
      for (let i = 0; i < 10; i++) table.fail(["user:owner"]);
      for (let i = 0; i < 9_999; i++) table.fail([`ip:${i}`]);
      expect(table.size(), name).toBe(10_000);
      const accepted = table.fail(["ip:new"]);
      expect(accepted, name).toBe(name === "passkey");
      expect(table.size(), name).toBe(10_000);
      expect(table.retryAfterMs(["ip:new"]), name).toBe(name === "passkey" ? 1000 : 0);
      expect(table.retryAfterMs(["user:owner"]), name).toBe(name === "passkey" ? 0 : 60_000);
    }
  });
});
