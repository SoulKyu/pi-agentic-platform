import { AGENT_VM_PROTOCOL } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { BUILD_NOTICE, createImagePolicy, isoWeek } from "./image-policy.ts";

/*
 * Mutants, each run for real: the protocol comparison removed (the two "refuse" cases); the notice not remembered
 * ("once"); the claim not marked in flight ("one claim"); the week key without the ISO year ("year boundary"); a failed
 * upgrade recorded as done ("a failed upgrade"); the built set ignored ("built").
 */
const tag = (layer: "base" | "profile" | "agent", c: string) => `pap-agent-${layer}-${c.repeat(64)}`;
const OLD = tag("profile", "a");
const NEW = tag("profile", "b");
const none: ReadonlySet<string> = new Set();
const policy = (lastBaseWeek: string | null = null) => {
  const clock = createFakeClock(Date.UTC(2026, 9, 19, 12));
  return { clock, image: createImagePolicy({ clock, lastBaseWeek }) };
};
const running = (t: string, protocol = AGENT_VM_PROTOCOL) => ({ tag: t, protocol });

describe("decide", () => {
  it("uses the image when it is the wanted one", () => {
    const { image } = policy();
    expect(image.decide({ agentId: "a1", wanted: OLD, running: running(OLD), built: none })).toEqual({
      action: "use",
      tag: OLD,
    });
  });

  // Mutant "built set ignored": the agent would stay on the old image for ever.
  it("moves to the wanted image once it is built (built)", () => {
    const { image } = policy();
    expect(
      image.decide({ agentId: "a1", wanted: NEW, running: running(OLD), built: new Set([NEW]) }),
    ).toEqual({ action: "use", tag: NEW });
  });

  // Mutant "notice not remembered".
  it("builds the new image, keeps the agent on the old one and posts the notice once (once)", () => {
    const { image } = policy();
    const input = { agentId: "a1", wanted: NEW, running: running(OLD), built: none };
    expect(image.decide(input)).toEqual({
      action: "build-then-use",
      build: NEW,
      use: OLD,
      notice: "Une nouvelle image est en préparation ; cet agent tourne sur l'ancienne.",
    });
    expect(BUILD_NOTICE).toBe("Une nouvelle image est en préparation ; cet agent tourne sur l'ancienne.");
    expect(image.decide(input)).toEqual({ action: "build-then-use", build: NEW, use: OLD, notice: null });
    expect(image.decide({ ...input, agentId: "a2" })).toMatchObject({ notice: BUILD_NOTICE });
    expect(image.decide({ ...input, wanted: tag("profile", "c") })).toMatchObject({ notice: BUILD_NOTICE });
  });

  it("with no image yet, builds and the start waits: no notice about an old image", () => {
    const { image } = policy();
    expect(image.decide({ agentId: "a1", wanted: NEW, running: null, built: none })).toEqual({
      action: "build-then-use",
      build: NEW,
      use: null,
      notice: null,
    });
  });

  // Mutant "protocol comparison removed".
  it("refuses an image whose protocol differs, whether or not a new one is building (refuse)", () => {
    const { image } = policy();
    const old = running(OLD, AGENT_VM_PROTOCOL + 1);
    const refused = {
      action: "refuse",
      reason: "protocol",
      running: old.protocol,
      expected: AGENT_VM_PROTOCOL,
    };
    expect(image.decide({ agentId: "a1", wanted: NEW, running: old, built: none })).toEqual(refused);
    expect(image.decide({ agentId: "a1", wanted: OLD, running: old, built: none })).toEqual(refused);
    expect(image.decide({ agentId: "a1", wanted: NEW, running: old, built: new Set([NEW]) })).toEqual({
      action: "use",
      tag: NEW,
    });
  });
});

describe("the weekly base rebuild", () => {
  it("names ISO weeks, with the ISO year at the boundary (year boundary)", () => {
    expect(isoWeek(Date.UTC(2026, 9, 19))).toBe("2026-W43");
    expect(isoWeek(Date.UTC(2026, 9, 25, 23, 59))).toBe("2026-W43");
    expect(isoWeek(Date.UTC(2026, 9, 26))).toBe("2026-W44");
    expect(isoWeek(Date.UTC(2026, 11, 31))).toBe("2026-W53");
    expect(isoWeek(Date.UTC(2027, 0, 3))).toBe("2026-W53");
    expect(isoWeek(Date.UTC(2027, 0, 4))).toBe("2027-W01");
    expect(isoWeek(Date.UTC(2024, 11, 30))).toBe("2025-W01");
  });

  // Mutant "claim not marked in flight".
  it("hands out one claim a week: a second caller gets none while it runs (one claim)", async () => {
    const { image, clock } = policy();
    const week = image.claimBaseUpgrade();
    expect(week).toBe("2026-W43");
    expect(image.claimBaseUpgrade()).toBeNull();
    image.baseUpgradeFinished(week ?? "", true);
    await clock.advance(6 * 24 * 3_600_000);
    expect(isoWeek(clock.now())).toBe("2026-W43");
    expect(image.claimBaseUpgrade()).toBeNull();
    await clock.advance(24 * 3_600_000);
    expect(image.claimBaseUpgrade()).toBe("2026-W44");
  });

  it("does not claim a week the persisted state says was done", () => {
    const { image } = policy("2026-W43");
    expect(image.claimBaseUpgrade()).toBeNull();
  });

  // Mutant "failed upgrade recorded as done".
  it("a failed upgrade is retried after an hour, not at once and not next week (a failed upgrade)", async () => {
    const { image, clock } = policy();
    image.baseUpgradeFinished(image.claimBaseUpgrade() ?? "", false);
    expect(image.claimBaseUpgrade()).toBeNull();
    await clock.advance(3_600_000 - 1);
    expect(image.claimBaseUpgrade()).toBeNull();
    await clock.advance(1);
    expect(image.claimBaseUpgrade()).toBe("2026-W43");
  });

  it("baseKey changes with a successful upgrade only, so the profile and agent tags follow it", () => {
    const { image } = policy();
    const base = tag("base", "d");
    const before = image.baseKey(base);
    image.baseUpgradeFinished(image.claimBaseUpgrade() ?? "", false);
    expect(image.baseKey(base)).toBe(before);
    image.baseUpgradeFinished("2026-W43", true);
    expect(image.baseKey(base)).not.toBe(before);
    expect(image.baseKey(base)).toBe(image.baseKey(base));
    expect(image.baseKey(tag("base", "e"))).not.toBe(image.baseKey(base));
  });
});
