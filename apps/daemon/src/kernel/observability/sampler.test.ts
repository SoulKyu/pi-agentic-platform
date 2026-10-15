import { describe, expect, it } from "vitest";
import { createLoopSampler } from "./stall.ts";

describe("the real loop sampler", () => {
  it("returns finite readings and can be stopped, with no wait", () => {
    const sampler = createLoopSampler();
    const first = sampler.sample();
    expect(Number.isFinite(first.delayMaxNs)).toBe(true);
    expect(first.delayMaxNs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(first.activeMs)).toBe(true);
    expect(first.activeMs).toBeGreaterThanOrEqual(0);
    const second = sampler.sample();
    expect(second.activeMs).toBeGreaterThanOrEqual(0);
    sampler.stop();
    sampler.stop();
  });
});
