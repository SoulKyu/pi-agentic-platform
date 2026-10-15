import { describe, expect, it } from "vitest";
import { ScheduleSource } from "./automation.ts";
import { nextOccurrence, nextOccurrences } from "./rrule-next.ts";
import { isSupportedRrule, type ParsedRrule, parseRrule } from "./rrule.ts";

const rule = (text: string): ParsedRrule => {
  const parsed = parseRrule(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
  return parsed.rule;
};
const at = (iso: string): number => Date.parse(iso);
const iso = (instants: readonly number[]): string[] => instants.map((t) => new Date(t).toISOString());

describe("parseRrule", () => {
  it.each([
    ["FREQ=MINUTELY;INTERVAL=5", { freq: "MINUTELY", interval: 5 }],
    ["FREQ=MINUTELY;INTERVAL=1440", { freq: "MINUTELY", interval: 1440 }],
    ["FREQ=HOURLY", { freq: "HOURLY", interval: 1, minutes: [0] }],
    ["FREQ=HOURLY;INTERVAL=24;BYMINUTE=35,5", { freq: "HOURLY", interval: 24, minutes: [5, 35] }],
    ["FREQ=DAILY;BYHOUR=18,6", { freq: "DAILY", hours: [6, 18], minute: 0 }],
    ["FREQ=DAILY;BYHOUR=2;BYMINUTE=30", { freq: "DAILY", hours: [2], minute: 30 }],
    ["FREQ=WEEKLY;BYDAY=FR,MO;BYHOUR=9", { freq: "WEEKLY", days: [0, 4], hours: [9], minute: 0 }],
  ])("accepts %s", (text, expected) => {
    expect(parseRrule(text)).toEqual({ ok: true, rule: expected });
    expect(isSupportedRrule(text)).toBe(true);
  });

  it.each([
    ["FREQ=DAILY;BYHOUR=2;COUNT=3", "rrule_unsupported"],
    ["FREQ=DAILY;BYHOUR=2;UNTIL=20270101T000000Z", "rrule_unsupported"],
    ["FREQ=MONTHLY;BYMONTHDAY=1", "rrule_unsupported"],
    ["FREQ=YEARLY", "rrule_unsupported"],
    ["FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYSETPOS=1", "rrule_unsupported"],
    ["FREQ=DAILY;BYHOUR=2;BYMONTHDAY=3", "rrule_unsupported"],
    ["FREQ=HOURLY;BYHOUR=3", "rrule_unsupported"],
    ["BYHOUR=2", "rrule_unsupported"],
    ["FREQ=MINUTELY;INTERVAL=4", "rrule_value"],
    ["FREQ=MINUTELY;INTERVAL=1441", "rrule_value"],
    ["FREQ=MINUTELY", "rrule_value"],
    ["FREQ=HOURLY;INTERVAL=25", "rrule_value"],
    ["FREQ=HOURLY;INTERVAL=0", "rrule_value"],
    ["FREQ=HOURLY;BYMINUTE=60", "rrule_value"],
    ["FREQ=HOURLY;BYMINUTE=0,1,2,3,4,5,6,7,8,9,10,11,12", "rrule_value"],
    ["FREQ=DAILY", "rrule_value"],
    ["FREQ=DAILY;BYHOUR=24", "rrule_value"],
    ["FREQ=DAILY;BYHOUR=", "rrule_value"],
    ["FREQ=DAILY;BYHOUR=2;BYMINUTE=0,30", "rrule_value"],
    ["FREQ=DAILY;BYHOUR=2,2", "rrule_value"],
    ["FREQ=DAILY;BYHOUR=2;BYHOUR=3", "rrule_value"],
    ["FREQ=WEEKLY;BYDAY=;BYHOUR=9", "rrule_value"],
    ["FREQ=WEEKLY;BYDAY=XX;BYHOUR=9", "rrule_value"],
    ["FREQ=WEEKLY;BYDAY=1MO;BYHOUR=9", "rrule_value"],
    ["FREQ=WEEKLY;BYHOUR=9", "rrule_value"],
  ])("refuses %s as %s", (text, reason) => {
    expect(parseRrule(text)).toEqual({ ok: false, reason });
    expect(isSupportedRrule(text)).toBe(false);
  });
});

describe("nextOccurrence", () => {
  it("every 15 minutes from 10:07 gives 10:15 then 10:30", () => {
    const from = at("2026-06-01T10:07:00Z");
    expect(iso(nextOccurrences(rule("FREQ=MINUTELY;INTERVAL=15"), "UTC", from, 2))).toEqual([
      "2026-06-01T10:15:00.000Z",
      "2026-06-01T10:30:00.000Z",
    ]);
  });

  it("is strictly after the instant it is given", () => {
    const exact = at("2026-06-01T10:15:00Z");
    expect(nextOccurrence(rule("FREQ=MINUTELY;INTERVAL=15"), "UTC", exact)).toBe(exact + 15 * 60_000);
  });

  it("hourly at :05 and :35", () => {
    const from = at("2026-06-01T10:07:00Z");
    expect(iso(nextOccurrences(rule("FREQ=HOURLY;BYMINUTE=5,35"), "UTC", from, 3))).toEqual([
      "2026-06-01T10:35:00.000Z",
      "2026-06-01T11:05:00.000Z",
      "2026-06-01T11:35:00.000Z",
    ]);
  });

  it("hourly with an interval keeps the hours of the day divisible by it", () => {
    const from = at("2026-06-01T07:00:00Z");
    expect(iso(nextOccurrences(rule("FREQ=HOURLY;INTERVAL=6"), "UTC", from, 3))).toEqual([
      "2026-06-01T12:00:00.000Z",
      "2026-06-01T18:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
    ]);
  });

  it("minutes of the local day divisible by n restart at midnight", () => {
    const from = at("2026-06-01T23:50:00Z");
    expect(iso(nextOccurrences(rule("FREQ=MINUTELY;INTERVAL=7"), "UTC", from, 2))).toEqual([
      "2026-06-01T23:55:00.000Z",
      "2026-06-02T00:00:00.000Z",
    ]);
  });

  it("daily 02:00 in Asia/Tokyo from a UTC instant", () => {
    const from = at("2026-06-01T10:00:00Z");
    expect(iso(nextOccurrences(rule("FREQ=DAILY;BYHOUR=2"), "Asia/Tokyo", from, 2))).toEqual([
      "2026-06-01T17:00:00.000Z",
      "2026-06-02T17:00:00.000Z",
    ]);
  });

  it("weekdays 09:00 from a Friday 10:00 gives Monday 09:00", () => {
    const friday = at("2026-06-05T10:00:00Z");
    expect(nextOccurrence(rule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9"), "UTC", friday)).toBe(
      at("2026-06-08T09:00:00Z"),
    );
  });

  it("a weekly rule on one day is found 7 days later", () => {
    const monday = at("2026-06-08T09:00:00Z");
    expect(nextOccurrence(rule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9"), "UTC", monday)).toBe(
      at("2026-06-15T09:00:00Z"),
    );
  });

  it("the local day, not the UTC day, picks the weekday", () => {
    // 2026-06-07 20:00Z is already Monday 05:00 in Tokyo.
    expect(
      nextOccurrence(rule("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9"), "Asia/Tokyo", at("2026-06-07T20:00:00Z")),
    ).toBe(at("2026-06-08T00:00:00Z"));
  });

  it("leap day: 29 February exists in 2028 and not in 2026", () => {
    const daily = rule("FREQ=DAILY;BYHOUR=23;BYMINUTE=30");
    expect(iso(nextOccurrences(daily, "UTC", at("2028-02-28T23:45:00Z"), 2))).toEqual([
      "2028-02-29T23:30:00.000Z",
      "2028-03-01T23:30:00.000Z",
    ]);
    expect(iso(nextOccurrences(daily, "UTC", at("2026-02-28T23:45:00Z"), 1))).toEqual([
      "2026-03-01T23:30:00.000Z",
    ]);
  });

  it("month ends and the year end roll over", () => {
    const daily = rule("FREQ=DAILY;BYHOUR=0;BYMINUTE=5");
    expect(iso(nextOccurrences(daily, "UTC", at("2026-01-31T00:05:00Z"), 1))).toEqual([
      "2026-02-01T00:05:00.000Z",
    ]);
    expect(iso(nextOccurrences(daily, "UTC", at("2026-04-30T12:00:00Z"), 1))).toEqual([
      "2026-05-01T00:05:00.000Z",
    ]);
    expect(iso(nextOccurrences(daily, "UTC", at("2026-12-31T12:00:00Z"), 1))).toEqual([
      "2027-01-01T00:05:00.000Z",
    ]);
  });

  it("returns at most 10 occurrences", () => {
    expect(nextOccurrences(rule("FREQ=MINUTELY;INTERVAL=5"), "UTC", 0, 50)).toHaveLength(10);
  });
});

describe("ScheduleSource", () => {
  const source = (rrule: string) => ScheduleSource.safeParse({ type: "schedule", rrule, timezone: "UTC" });
  it("accepts a supported rule and refuses an unsupported one", () => {
    expect(source("FREQ=DAILY;BYHOUR=2").success).toBe(true);
    expect(source("FREQ=MONTHLY;BYMONTHDAY=1").success).toBe(false);
    expect(source("FREQ=DAILY").success).toBe(false);
  });
});

describe("prototype names are plain refusals (never a throw)", () => {
  it.each([
    "FREQ=constructor",
    "FREQ=toString",
    "FREQ=__proto__",
    "__proto__=1",
    "toString=1",
    "FREQ=DAILY;constructor=1",
  ])("%s", (text) => {
    expect(() => parseRrule(text)).not.toThrow();
    expect(parseRrule(text).ok).toBe(false);
    expect(() => ScheduleSource.safeParse({ type: "schedule", rrule: text, timezone: "UTC" })).not.toThrow();
    expect(ScheduleSource.safeParse({ type: "schedule", rrule: text, timezone: "UTC" }).success).toBe(false);
  });

  it("refuses prototype names that pass the shape check, with the closed reason", () => {
    // Upper-case prototype-like names reach the key lookup; `__PROTO__` is not special but must not throw either.
    expect(parseRrule("FREQ=CONSTRUCTOR")).toEqual({ ok: false, reason: "rrule_unsupported" });
    expect(parseRrule("FREQ=DAILY;BYHOUR=2;__PROTO__=1")).toEqual({ ok: false, reason: "rrule_unsupported" });
  });
});
