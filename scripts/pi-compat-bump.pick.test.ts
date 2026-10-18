import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGES, pickNewest, readMinimumReleaseAge } from "./pi-compat-bump.ts";

type Times = Record<string, Record<string, string>>;
const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "pi-registry-time.json"), "utf8"),
) as Times;
const AGE = 4320;
const MINUTE = 60_000;
const at = (iso: string) => Date.parse(iso);
const clone = (): Times => structuredClone(fixture);

const latestPublish = (times: Times, version: string): number =>
  Math.max(...PACKAGES.map((name) => Date.parse(times[name]?.[version] ?? "")));

describe("pickNewest with the registry fixture", () => {
  it("covers the three packages", () => {
    expect(Object.keys(fixture).sort()).toEqual([...PACKAGES].sort());
  });

  it("picks 1.2.0 while 1.3.0 is younger than the rule", () => {
    expect(pickNewest(fixture, at("2026-10-18T04:30:00Z"), AGE)).toBe("1.2.0");
  });

  it("picks 1.3.0 from the minute the last of its three packages is 3 days old", () => {
    const eligible = latestPublish(fixture, "1.3.0") + AGE * MINUTE;
    expect(pickNewest(fixture, eligible + MINUTE, AGE)).toBe("1.3.0");
    expect(pickNewest(fixture, eligible, AGE)).toBe("1.3.0");
  });

  it("still picks 1.2.0 one minute before 1.3.0 becomes eligible", () => {
    const eligible = latestPublish(fixture, "1.3.0") + AGE * MINUTE;
    expect(pickNewest(fixture, eligible - MINUTE, AGE)).toBe("1.2.0");
  });

  it("picks 1.1.0 while 1.2.0 is not yet published", () => {
    expect(pickNewest(fixture, at("2026-10-12T00:00:00Z"), AGE)).toBe("1.1.0");
  });

  it("returns null when nothing is old enough", () => {
    expect(pickNewest(fixture, at("2026-09-01T00:00:00Z"), AGE)).toBeNull();
  });

  it("returns null for an empty set", () => {
    expect(pickNewest({}, at("2026-10-18T04:30:00Z"), AGE)).toBeNull();
    expect(
      pickNewest({ [PACKAGES[0]]: {}, [PACKAGES[1]]: {}, [PACKAGES[2]]: {} }, Date.now(), AGE),
    ).toBeNull();
  });
});

describe("pickNewest edge cases", () => {
  const now = at("2026-10-18T04:30:00Z");

  it("skips a version that one package does not have", () => {
    const times = clone();
    delete times[PACKAGES[1]]?.["1.2.0"];
    expect(pickNewest(times, now, AGE)).toBe("1.1.0");
  });

  it("skips a version whose time is missing or unreadable in one package", () => {
    const times = clone();
    times[PACKAGES[2]] = { ...times[PACKAGES[2]], "1.2.0": "not a date" };
    expect(pickNewest(times, now, AGE)).toBe("1.1.0");
  });

  it("requires every package to satisfy the age, not just the first", () => {
    const times = clone();
    times[PACKAGES[2]] = { ...times[PACKAGES[2]], "1.2.0": "2026-10-17T00:00:00.000Z" };
    expect(pickNewest(times, now, AGE)).toBe("1.1.0");
  });

  it("never picks a pre-release, however old and however high", () => {
    const times = clone();
    for (const name of PACKAGES) times[name] = { ...times[name], "1.4.0-beta.1": "2026-09-01T00:00:00.000Z" };
    expect(pickNewest(times, now, AGE)).toBe("1.2.0");
  });

  it("ignores registry bookkeeping keys such as created and modified", () => {
    const times = clone();
    for (const name of PACKAGES) {
      times[name] = {
        ...times[name],
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-10-18T00:00:00.000Z",
      };
    }
    expect(pickNewest(times, now, AGE)).toBe("1.2.0");
  });

  it("compares versions numerically, not as text", () => {
    const times: Times = {};
    for (const name of PACKAGES) {
      times[name] = { "1.9.0": "2026-01-01T00:00:00.000Z", "1.10.0": "2026-01-02T00:00:00.000Z" };
    }
    expect(pickNewest(times, now, AGE)).toBe("1.10.0");
  });

  it("uses the minimum age it is given", () => {
    const publishedAt = latestPublish(fixture, "1.3.0");
    expect(pickNewest(fixture, publishedAt + 10 * MINUTE, 10)).toBe("1.3.0");
    expect(pickNewest(fixture, publishedAt + 9 * MINUTE, 10)).toBe("1.2.0");
  });
});

describe("readMinimumReleaseAge", () => {
  it("reads the number of minutes", () => {
    expect(readMinimumReleaseAge("catalog:\n  a: 1\nminimumReleaseAge: 4320\nother: 1\n")).toBe(4320);
    expect(readMinimumReleaseAge("minimumReleaseAge: 60 # an hour\n")).toBe(60);
  });

  it("throws when the rule is missing, so the job can never run without it", () => {
    expect(() => readMinimumReleaseAge("catalog:\n  a: 1\n")).toThrow(/minimumReleaseAge/);
    expect(() => readMinimumReleaseAge("# minimumReleaseAge: 4320\n")).toThrow(/minimumReleaseAge/);
  });
});
