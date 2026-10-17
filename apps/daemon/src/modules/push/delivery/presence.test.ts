import { describe, expect, it } from "vitest";
import { PapError } from "@pap/contracts";
import { createFakeClock } from "../../../kernel/clock.ts";
import { createPresence } from "./presence.ts";

describe("presence", () => {
  it("is fresh within 45 s and stale after", async () => {
    const clock = createFakeClock();
    const presence = createPresence(clock);
    presence.report("u1", "c1", true);
    await clock.advance(45_000);
    expect(presence.looking("u1")).toBe(true);
    await clock.advance(1);
    expect(presence.looking("u1")).toBe(false);
  });

  it("a heartbeat refreshes the entry", async () => {
    const clock = createFakeClock();
    const presence = createPresence(clock);
    presence.report("u1", "c1", true);
    await clock.advance(40_000);
    presence.report("u1", "c1", true);
    await clock.advance(40_000);
    expect(presence.looking("u1")).toBe(true);
  });

  it("is not looking for an unfocused-only entry, and focus can be withdrawn", () => {
    const presence = createPresence(createFakeClock());
    presence.report("u1", "c1", false);
    expect(presence.looking("u1")).toBe(false);
    presence.report("u1", "c1", true);
    expect(presence.looking("u1")).toBe(true);
    presence.report("u1", "c1", false);
    expect(presence.looking("u1")).toBe(false);
  });

  it("keeps one entry per connection id: another unfocused tab does not hide a focused one", () => {
    const presence = createPresence(createFakeClock());
    presence.report("u1", "c1", true);
    presence.report("u1", "c2", false);
    expect(presence.looking("u1")).toBe(true);
  });

  it("isolates owners", () => {
    const presence = createPresence(createFakeClock());
    presence.report("u1", "c1", true);
    expect(presence.looking("u2")).toBe(false);
    expect(presence.looking("u1")).toBe(true);
  });

  it("refuses the 65th live entry with capacity and never evicts", () => {
    const presence = createPresence(createFakeClock());
    for (let i = 0; i < 64; i++) presence.report("u1", `c${i}`, true);
    expect(() => presence.report("u2", "new", true)).toThrow(PapError);
    expect(() => presence.report("u2", "new", true)).toThrow("capacity");
    expect(presence.looking("u2")).toBe(false);
    expect(presence.looking("u1")).toBe(true);
    presence.report("u1", "c0", false); // an existing connection still reports
  });

  it("sweeps expired entries before refusing", async () => {
    const clock = createFakeClock();
    const presence = createPresence(clock);
    for (let i = 0; i < 64; i++) presence.report("u1", `c${i}`, true);
    await clock.advance(45_001);
    presence.report("u2", "new", true);
    expect(presence.looking("u2")).toBe(true);
    expect(presence.looking("u1")).toBe(false);
  });
});
