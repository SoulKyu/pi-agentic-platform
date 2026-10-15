import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createHookRate } from "./hook-rate.ts";

describe("the authenticated delivery rate", () => {
  it("passes 60 in a minute, refuses the 61st and opens the next window a minute after the first", async () => {
    const clock = createFakeClock();
    const rate = createHookRate(clock);
    for (let index = 0; index < 60; index += 1) expect(rate.count("a")).toBe("ok");
    expect(rate.count("a")).toBe("rate");
    expect(rate.count("a")).toBe("rate");
    await clock.advance(59_999);
    expect(rate.count("a")).toBe("rate");
    await clock.advance(1);
    expect(rate.count("a")).toBe("ok");
  });

  it("counts each trigger on its own", () => {
    const rate = createHookRate(createFakeClock());
    for (let index = 0; index < 60; index += 1) rate.count("a");
    expect(rate.count("a")).toBe("rate");
    expect(rate.count("b")).toBe("ok");
  });

  it("forgets a deleted trigger", () => {
    const rate = createHookRate(createFakeClock());
    for (let index = 0; index < 61; index += 1) rate.count("a");
    expect(rate.size()).toBe(1);
    rate.forget("a");
    expect(rate.size()).toBe(0);
    expect(rate.count("a")).toBe("ok");
  });
});
