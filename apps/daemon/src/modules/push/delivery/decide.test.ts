import { describe, expect, it } from "vitest";
import { NotificationsSettings, type PushClass } from "@pap/contracts";
import { decide } from "./decide.ts";

const NOW = 1_000_000;
const defaults = (): NotificationsSettings => NotificationsSettings.parse({});
const input = (over: Partial<Parameters<typeof decide>[0]> = {}): Parameters<typeof decide>[0] => ({
  cls: "failed",
  now: NOW,
  settings: defaults(),
  quiet: false,
  looking: false,
  cooldownFree: true,
  hourCount: 0,
  rechecks: 0,
  ...over,
});
const off = (cls: PushClass): NotificationsSettings => {
  const s = defaults();
  return { ...s, classes: { ...s.classes, [cls]: false } };
};
const muted = (): NotificationsSettings => ({ ...defaults(), muteUntil: NOW + 1 });

describe("decide", () => {
  it("sends a plain event", () => {
    expect(decide(input())).toEqual({ action: "send" });
  });

  it("suppresses a class that is off, and sends the default-on ones", () => {
    expect(decide(input({ cls: "done" }))).toEqual({ action: "suppress", reason: "class_off" });
    expect(decide(input({ cls: "failed", settings: off("failed") }))).toEqual({
      action: "suppress",
      reason: "class_off",
    });
  });

  it("suppresses while muted, not once muteUntil has passed", () => {
    expect(decide(input({ settings: muted() }))).toEqual({ action: "suppress", reason: "muted" });
    expect(decide(input({ settings: { ...defaults(), muteUntil: NOW } }))).toEqual({ action: "send" });
  });

  it("suppresses focused for a non-approval and rechecks an approval three times", () => {
    expect(decide(input({ looking: true }))).toEqual({ action: "suppress", reason: "focused" });
    const approval = (rechecks: number) => decide(input({ cls: "approval", looking: true, rechecks }));
    expect(approval(0)).toEqual({ action: "recheck", afterMs: 60_000 });
    expect(approval(2)).toEqual({ action: "recheck", afterMs: 60_000 });
    expect(approval(3)).toEqual({ action: "suppress", reason: "focused" });
  });

  it("suppresses on cooldown", () => {
    expect(decide(input({ cooldownFree: false }))).toEqual({ action: "suppress", reason: "cooldown" });
  });

  it("caps at 20 an hour: 19 sends, 20 is refused", () => {
    expect(decide(input({ hourCount: 19 }))).toEqual({ action: "send" });
    expect(decide(input({ hourCount: 20 }))).toEqual({ action: "suppress", reason: "rate_cap" });
  });

  it("never rate-caps an approval, even at 500", () => {
    expect(decide(input({ cls: "approval", hourCount: 500 }))).toEqual({ action: "send" });
  });

  it("holds in quiet hours", () => {
    expect(decide(input({ quiet: true }))).toEqual({ action: "hold" });
    expect(decide(input({ cls: "approval", quiet: true }))).toEqual({ action: "hold" });
  });

  describe("the order", () => {
    const all = {
      cls: "done" as const,
      settings: { ...muted() },
      looking: true,
      cooldownFree: false,
      hourCount: 99,
      quiet: true,
    };
    it("class off beats muted", () => {
      expect(decide(input(all))).toEqual({ action: "suppress", reason: "class_off" });
    });
    it("muted beats looking", () => {
      expect(decide(input({ ...all, cls: "failed" }))).toEqual({ action: "suppress", reason: "muted" });
    });
    it("looking beats cooldown", () => {
      expect(decide(input({ ...all, cls: "failed", settings: defaults() }))).toEqual({
        action: "suppress",
        reason: "focused",
      });
    });
    it("cooldown beats the rate cap", () => {
      expect(decide(input({ ...all, cls: "failed", settings: defaults(), looking: false }))).toEqual({
        action: "suppress",
        reason: "cooldown",
      });
    });
    it("the rate cap beats quiet", () => {
      expect(
        decide(input({ ...all, cls: "failed", settings: defaults(), looking: false, cooldownFree: true })),
      ).toEqual({ action: "suppress", reason: "rate_cap" });
    });
    it("quiet comes last", () => {
      expect(
        decide(
          input({
            ...all,
            cls: "failed",
            settings: defaults(),
            looking: false,
            cooldownFree: true,
            hourCount: 0,
          }),
        ),
      ).toEqual({ action: "hold" });
    });
  });

  describe("digest", () => {
    const base = { cls: "digest" as const, quiet: true, cooldownFree: false, hourCount: 99 };
    it("ignores class toggles, quiet hours, cooldown and the cap", () => {
      const settings = { ...defaults(), classes: { ...defaults().classes, failed: false, approval: false } };
      expect(decide(input({ ...base, settings }))).toEqual({ action: "send" });
    });
    it("still obeys mute and focus", () => {
      expect(decide(input({ ...base, settings: muted() }))).toEqual({ action: "suppress", reason: "muted" });
      expect(decide(input({ ...base, looking: true }))).toEqual({ action: "suppress", reason: "focused" });
    });
  });

  it("a test push ignores everything and sends", () => {
    expect(
      decide(
        input({
          cls: "test",
          settings: muted(),
          quiet: true,
          looking: true,
          cooldownFree: false,
          hourCount: 500,
        }),
      ),
    ).toEqual({ action: "send" });
  });
});
