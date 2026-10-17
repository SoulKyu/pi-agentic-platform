import { describe, expect, it } from "vitest";
import { parseWhen, REMIND_MAX_MS, REMIND_MIN_MS } from "./when.ts";

const NOW = Date.parse("2026-10-16T08:00:00Z");
const MINUTE = 60_000;

describe("parseWhen (M11R80)", () => {
  it.each([
    ["30m", NOW + 30 * MINUTE],
    ["2h", NOW + 120 * MINUTE],
    ["3d", NOW + 3 * 1440 * MINUTE],
    ["15m", NOW + REMIND_MIN_MS],
    ["30d", NOW + REMIND_MAX_MS],
    ["720h", NOW + REMIND_MAX_MS],
    ["2026-10-16T12:00:00+02:00", Date.parse("2026-10-16T10:00:00Z")],
    ["2026-10-17T09:00:00Z", Date.parse("2026-10-17T09:00:00Z")],
    ["2026-10-17T09:00Z", Date.parse("2026-10-17T09:00:00Z")],
    ["2026-10-17T09:00:30.5Z", Date.parse("2026-10-17T09:00:30.500Z")],
    ["2026-10-17T09:00:00-05:30", Date.parse("2026-10-17T14:30:00Z")],
  ])("reads %s", (text, at) => {
    expect(parseWhen(text, NOW)).toBe(at);
  });

  it.each([
    ["9am", "free form"],
    ["tomorrow", "free form"],
    ["in 2 hours", "free form"],
    ["2026-10-17T09:00:00", "no offset"],
    ["2026-10-17 09:00:00Z", "a space for the T"],
    ["10s", "seconds are no unit"],
    ["31d", "past 30 days"],
    ["721h", "past 30 days"],
    ["14m", "under 15 minutes"],
    ["0m", "zero"],
    ["05m", "a leading zero"],
    ["-30m", "a sign"],
    ["1.5h", "a fraction"],
    [" 2h", "a leading space"],
    ["2h ", "a trailing space"],
    ["2H", "a capital unit"],
    ["2026-02-30T09:00:00Z", "a day that does not exist"],
    ["2026-13-01T09:00:00Z", "a month that does not exist"],
    ["2026-10-17T24:00:00Z", "an hour that does not exist"],
    ["2026-10-17T09:60:00Z", "a minute that does not exist"],
    ["2026-10-17T09:00:60Z", "a leap second"],
    ["2026-10-17T09:00:00+24:00", "an offset past a day"],
    ["2026-10-17T09:00:00+02:60", "an offset minute that does not exist"],
    ["2026-10-16T08:10:00Z", "under 15 minutes by the calendar"],
    ["2026-09-01T09:00:00Z", "in the past"],
    ["2026-12-01T09:00:00Z", "past 30 days by the calendar"],
    ["0050-10-17T09:00:00Z", "a year of two digits"],
    ["", "empty"],
  ])("refuses %j (%s)", (text) => {
    expect(parseWhen(text, NOW)).toBeNull();
  });

  it("measures from the clock it is given, not from the real one", () => {
    expect(parseWhen("1h", 0)).toBe(60 * MINUTE);
    expect(parseWhen("1h", 5 * MINUTE)).toBe(65 * MINUTE);
  });

  it("holds the bounds one millisecond either side of the edge", () => {
    const edge = (offset: number) => new Date(NOW + offset).toISOString();
    expect(parseWhen(edge(REMIND_MIN_MS), NOW)).toBe(NOW + REMIND_MIN_MS);
    expect(parseWhen(edge(REMIND_MIN_MS - 1), NOW)).toBeNull();
    expect(parseWhen(edge(REMIND_MAX_MS), NOW)).toBe(NOW + REMIND_MAX_MS);
    expect(parseWhen(edge(REMIND_MAX_MS + 1), NOW)).toBeNull();
  });
});
