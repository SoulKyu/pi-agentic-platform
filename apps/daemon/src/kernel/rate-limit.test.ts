import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock.ts";
import { createRateLimiter } from "./rate-limit.ts";

describe("rate limiter", () => {
  it("lets the first through, refuses the rest of the window and counts them", async () => {
    const clock = createFakeClock();
    const limiter = createRateLimiter(clock, 10_000);
    expect(limiter.check("a")).toEqual({ allowed: true, suppressed: 0 });
    expect(limiter.check("a")).toEqual({ allowed: false, suppressed: 1 });
    expect(limiter.check("a")).toEqual({ allowed: false, suppressed: 2 });
    await clock.advance(9_999);
    expect(limiter.check("a").allowed).toBe(false);
    await clock.advance(1);
    expect(limiter.check("a")).toEqual({ allowed: true, suppressed: 3 });
    expect(limiter.check("a")).toEqual({ allowed: false, suppressed: 1 });
  });

  it("keeps a window per key", () => {
    const limiter = createRateLimiter(createFakeClock(), 10_000);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });
});
