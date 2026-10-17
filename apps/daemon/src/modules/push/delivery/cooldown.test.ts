import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { createCooldown } from "./cooldown.ts";

describe("cooldown", () => {
  it("refuses a second reserve within 5 s and allows it after", async () => {
    const clock = createFakeClock();
    const cooldown = createCooldown(clock);
    expect(cooldown.reserve("k")).toBe(true);
    await clock.advance(4_999);
    expect(cooldown.reserve("k")).toBe(false);
    await clock.advance(1);
    expect(cooldown.reserve("k")).toBe(true);
  });

  it("a refused reserve does not extend the window", async () => {
    const clock = createFakeClock();
    const cooldown = createCooldown(clock);
    cooldown.reserve("k");
    await clock.advance(3_000);
    cooldown.reserve("k");
    await clock.advance(2_000);
    expect(cooldown.reserve("k")).toBe(true);
  });

  it("keeps keys apart", () => {
    const cooldown = createCooldown(createFakeClock());
    expect(cooldown.reserve("a")).toBe(true);
    expect(cooldown.reserve("b")).toBe(true);
  });

  it("refuses a new key when 256 fresh keys are held, and does not evict the old ones", async () => {
    const clock = createFakeClock();
    const cooldown = createCooldown(clock);
    for (let i = 0; i < 256; i++) expect(cooldown.reserve(`k${i}`)).toBe(true);
    expect(cooldown.reserve("new")).toBe(false);
    expect(cooldown.reserve("k0")).toBe(false); // still held, not evicted
    await clock.advance(5_000);
    expect(cooldown.reserve("new")).toBe(true);
  });

  it("free asks without taking the window", async () => {
    const clock = createFakeClock();
    const cooldown = createCooldown(clock);
    expect(cooldown.free("k")).toBe(true);
    expect(cooldown.free("k")).toBe(true);
    expect(cooldown.reserve("k")).toBe(true);
    expect(cooldown.free("k")).toBe(false);
    await clock.advance(5_000);
    expect(cooldown.free("k")).toBe(true);
  });

  it("free refuses a new key when 256 fresh keys are held", () => {
    const cooldown = createCooldown(createFakeClock());
    for (let i = 0; i < 256; i++) cooldown.reserve(`k${i}`);
    expect(cooldown.free("new")).toBe(false);
    expect(cooldown.free("k0")).toBe(false);
  });
});
