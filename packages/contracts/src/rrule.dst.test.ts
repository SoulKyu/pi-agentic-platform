import { describe, expect, it } from "vitest";
import { nextOccurrences } from "./rrule-next.ts";
import { type ParsedRrule, parseRrule } from "./rrule.ts";

const rule = (text: string): ParsedRrule => {
  const parsed = parseRrule(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.reason}`);
  return parsed.rule;
};
const at = (iso: string): number => Date.parse(iso);
const iso = (instants: readonly number[]): string[] => instants.map((t) => new Date(t).toISOString());
const local = (zone: string, instant: number): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);

// Europe/Paris: 2026-03-29 02:00 CET jumps to 03:00 CEST (01:00Z); 2026-10-25 03:00 CEST falls back to 02:00 CET (01:00Z).
describe("Europe/Paris", () => {
  const paris = "Europe/Paris";

  it("a daily 02:30 inside the spring-forward gap fires at the first instant after it", () => {
    const daily = rule("FREQ=DAILY;BYHOUR=2;BYMINUTE=30");
    const found = nextOccurrences(daily, paris, at("2026-03-28T12:00:00Z"), 3);
    expect(iso(found)).toEqual([
      "2026-03-29T01:00:00.000Z",
      "2026-03-30T00:30:00.000Z",
      "2026-03-31T00:30:00.000Z",
    ]);
    expect(local(paris, found[0] as number)).toContain("03:00");
  });

  it("a daily 02:30 on the fall-back day fires once, at the first 02:30", () => {
    const daily = rule("FREQ=DAILY;BYHOUR=2;BYMINUTE=30");
    expect(iso(nextOccurrences(daily, paris, at("2026-10-24T12:00:00Z"), 3))).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
      "2026-10-27T01:30:00.000Z",
    ]);
  });

  it("a weekly rule fires once in the repeated hour too", () => {
    const sunday = rule("FREQ=WEEKLY;BYDAY=SU;BYHOUR=2;BYMINUTE=30");
    expect(iso(nextOccurrences(sunday, paris, at("2026-10-18T12:00:00Z"), 2))).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-11-01T01:30:00.000Z",
    ]);
  });

  it("hourly at :30 fires at both 02:30 of the fall-back day", () => {
    const hourly = rule("FREQ=HOURLY;BYMINUTE=30");
    const found = nextOccurrences(hourly, paris, at("2026-10-25T00:00:00Z"), 4);
    // The brief says 01:30Z and 02:30Z; the repeated wall hour in Paris is 00:xxZ then 01:xxZ.
    expect(iso(found)).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
      "2026-10-25T02:30:00.000Z",
      "2026-10-25T03:30:00.000Z",
    ]);
    expect(local(paris, found[0] as number)).toBe("02:30 CEST");
    expect(local(paris, found[1] as number)).toBe("02:30 CET");
  });

  it("every 15 minutes covers every wall-clock quarter of both passes of the repeated hour", () => {
    const quarter = rule("FREQ=MINUTELY;INTERVAL=15");
    const found = nextOccurrences(quarter, paris, at("2026-10-25T00:00:00Z") - 1, 10);
    expect(iso(found)).toEqual(
      Array.from({ length: 10 }, (_, i) => new Date(at("2026-10-25T00:00:00Z") + i * 900_000).toISOString()),
    );
    expect(found.slice(0, 8).map((t) => local(paris, t))).toEqual([
      "02:00 CEST",
      "02:15 CEST",
      "02:30 CEST",
      "02:45 CEST",
      "02:00 CET",
      "02:15 CET",
      "02:30 CET",
      "02:45 CET",
    ]);
  });

  it("every 15 minutes through the spring-forward gap fires once at the end of the gap", () => {
    const quarter = rule("FREQ=MINUTELY;INTERVAL=15");
    expect(iso(nextOccurrences(quarter, paris, at("2026-03-29T00:30:00Z"), 4))).toEqual([
      "2026-03-29T00:45:00.000Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-29T01:15:00.000Z",
      "2026-03-29T01:30:00.000Z",
    ]);
  });

  it("a rule at 03:00 on the spring-forward day does not fire twice at the gap's end", () => {
    const daily = rule("FREQ=DAILY;BYHOUR=2,3");
    expect(iso(nextOccurrences(daily, paris, at("2026-03-29T00:00:00Z"), 2))).toEqual([
      "2026-03-29T01:00:00.000Z",
      "2026-03-30T00:00:00.000Z",
    ]);
  });
});

// America/New_York: 2026-03-08 02:00 EST jumps to 03:00 EDT (07:00Z); 2026-11-01 02:00 EDT falls back to 01:00 EST (06:00Z).
describe("America/New_York", () => {
  const newYork = "America/New_York";

  it("2026-03-08: a daily 02:30 fires at 03:00 EDT, the next day at 02:30 EDT", () => {
    const daily = rule("FREQ=DAILY;BYHOUR=2;BYMINUTE=30");
    expect(iso(nextOccurrences(daily, newYork, at("2026-03-07T12:00:00Z"), 2))).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("2026-11-01: a daily 01:30 fires once, hourly :30 fires at both 01:30", () => {
    const daily = rule("FREQ=DAILY;BYHOUR=1;BYMINUTE=30");
    expect(iso(nextOccurrences(daily, newYork, at("2026-10-31T12:00:00Z"), 2))).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
    const hourly = rule("FREQ=HOURLY;BYMINUTE=30");
    expect(iso(nextOccurrences(hourly, newYork, at("2026-11-01T05:00:00Z"), 3))).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:30:00.000Z",
    ]);
  });
});

describe("half-hour and southern-hemisphere zones", () => {
  it("Asia/Kolkata (+05:30) has no transition", () => {
    expect(
      iso(nextOccurrences(rule("FREQ=DAILY;BYHOUR=9"), "Asia/Kolkata", at("2026-06-01T00:00:00Z"), 1)),
    ).toEqual(["2026-06-01T03:30:00.000Z"]);
  });

  it("Australia/Sydney: the spring-forward gap of 2026-10-04 (02:00 to 03:00)", () => {
    expect(
      iso(
        nextOccurrences(
          rule("FREQ=DAILY;BYHOUR=2;BYMINUTE=30"),
          "Australia/Sydney",
          at("2026-10-03T00:00:00Z"),
          2,
        ),
      ),
    ).toEqual(["2026-10-03T16:00:00.000Z", "2026-10-04T15:30:00.000Z"]);
  });
});
