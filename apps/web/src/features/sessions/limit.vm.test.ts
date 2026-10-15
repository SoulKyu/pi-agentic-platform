import { describe, expect, it } from "vitest";
import { limitView } from "../../testing/usage-bed.ts";
import { limitLabel } from "./limit.vm.ts";

const NOW = Date.UTC(2026, 9, 14, 10, 0);

describe("limitLabel", () => {
  it("names the reset time in the browser's zone, same day: just the time", () => {
    const view = limitView({ resetAt: Date.UTC(2026, 9, 14, 14, 30) });
    expect(limitLabel(view, { locale: "en", now: NOW, timeZone: "UTC" })).toEqual({
      key: "usage.limit.resets",
      time: "14:30",
    });
    expect(limitLabel(view, { locale: "en", now: NOW, timeZone: "Asia/Tokyo" })).toMatchObject({
      time: "23:30",
    });
  });

  it("adds the weekday when the reset is on another day there", () => {
    const view = limitView({ resetAt: Date.UTC(2026, 9, 15, 2, 0) });
    expect(limitLabel(view, { locale: "en", now: NOW, timeZone: "UTC" })).toEqual({
      key: "usage.limit.resets",
      time: "Thu 02:00",
    });
    expect(limitLabel(view, { locale: "fr", now: NOW, timeZone: "UTC" })).toMatchObject({
      time: "jeu. 02:00",
    });
  });

  it("says the limit was reached when there is no reset time", () => {
    expect(limitLabel(limitView({ resetAt: null }), { locale: "en", now: NOW })).toEqual({
      key: "usage.limit.reached",
    });
  });

  it("uses the browser's own zone by default", () => {
    const view = limitView({ resetAt: NOW + 3_600_000 });
    const label = limitLabel(view, { locale: "en", now: NOW });
    const expected = new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(view.resetAt as number);
    expect(label).toEqual({ key: "usage.limit.resets", time: expected });
  });
});
