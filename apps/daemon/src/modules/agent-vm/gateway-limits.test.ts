import { GATEWAY_LIMITS } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { createGatewayLimits } from "./gateway-limits.ts";

let clock: FakeClock;
beforeEach(() => {
  clock = createFakeClock();
});

describe("waiting connections", () => {
  it("admits pendingTotal connections from different sources and refuses the next", () => {
    const limits = createGatewayLimits(clock);
    for (let n = 0; n < GATEWAY_LIMITS.pendingTotal; n++) expect(limits.admit(`10.0.0.${n}`)).not.toBeNull();
    expect(limits.admit("10.0.1.1")).toBeNull();
  });

  it("admits pendingPerSource from one address and refuses the next", () => {
    const limits = createGatewayLimits(clock);
    for (let n = 0; n < GATEWAY_LIMITS.pendingPerSource; n++) expect(limits.admit("10.0.0.9")).not.toBeNull();
    expect(limits.admit("10.0.0.9")).toBeNull();
    expect(limits.admit("10.0.0.10")).not.toBeNull();
  });

  it("frees the place when a connection is released, once even if it is released twice", () => {
    const limits = createGatewayLimits(clock);
    const places = Array.from({ length: GATEWAY_LIMITS.pendingPerSource }, () => limits.admit("10.0.0.9"));
    places[0]?.();
    places[0]?.();
    expect(limits.admit("10.0.0.9")).not.toBeNull();
    expect(limits.admit("10.0.0.9")).toBeNull();
  });
});

describe("the byte window", () => {
  it("pauses past windowBytes and resumes when the window turns", async () => {
    const limits = createGatewayLimits(clock);
    const pause = vi.fn();
    const resume = vi.fn();
    const meter = limits.meter(pause, resume);
    meter.add(GATEWAY_LIMITS.windowBytes);
    expect(pause).not.toHaveBeenCalled();
    meter.add(1);
    expect(pause).toHaveBeenCalledTimes(1);
    await clock.advance(GATEWAY_LIMITS.windowMs - 1);
    expect(resume).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh count after the window: the bytes of the last one are forgotten", async () => {
    const limits = createGatewayLimits(clock);
    const pause = vi.fn();
    const meter = limits.meter(pause, vi.fn());
    meter.add(GATEWAY_LIMITS.windowBytes);
    await clock.advance(GATEWAY_LIMITS.windowMs);
    meter.add(GATEWAY_LIMITS.windowBytes);
    expect(pause).not.toHaveBeenCalled();
  });

  it("pauses once while paused, and stop() cancels the pending resume", async () => {
    const limits = createGatewayLimits(clock);
    const pause = vi.fn();
    const resume = vi.fn();
    const meter = limits.meter(pause, resume);
    meter.add(GATEWAY_LIMITS.windowBytes + 1);
    meter.add(10);
    expect(pause).toHaveBeenCalledTimes(1);
    meter.stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(GATEWAY_LIMITS.windowMs);
    expect(resume).not.toHaveBeenCalled();
  });
});
