import { describe, expect, it } from "vitest";
import { rangeStart, startOfLocalDay } from "./days.ts";

const utc = (iso: string) => Date.parse(iso);

describe("startOfLocalDay", () => {
  it("is local midnight in the zone", () => {
    expect(startOfLocalDay(utc("2026-10-14T12:00:00Z"), "Europe/Paris")).toBe(utc("2026-10-13T22:00:00Z"));
    expect(startOfLocalDay(utc("2026-10-14T12:00:00Z"), "UTC")).toBe(utc("2026-10-14T00:00:00Z"));
    expect(startOfLocalDay(utc("2026-10-14T12:00:00Z"), "America/New_York")).toBe(
      utc("2026-10-14T04:00:00Z"),
    );
  });

  it("switches day at local midnight, not at UTC midnight", () => {
    expect(startOfLocalDay(utc("2026-10-13T21:59:59Z"), "Europe/Paris")).toBe(utc("2026-10-12T22:00:00Z"));
    expect(startOfLocalDay(utc("2026-10-13T22:00:00Z"), "Europe/Paris")).toBe(utc("2026-10-13T22:00:00Z"));
  });

  it("follows the clock change: a 25-hour day and a 23-hour day", () => {
    // Paris falls back on 2026-10-25 (03:00 CEST -> 02:00 CET) and springs forward on 2026-03-29.
    expect(startOfLocalDay(utc("2026-10-25T20:00:00Z"), "Europe/Paris")).toBe(utc("2026-10-24T22:00:00Z"));
    expect(startOfLocalDay(utc("2026-10-26T10:00:00Z"), "Europe/Paris")).toBe(utc("2026-10-25T23:00:00Z"));
    expect(startOfLocalDay(utc("2026-03-29T20:00:00Z"), "Europe/Paris")).toBe(utc("2026-03-28T23:00:00Z"));
    expect(startOfLocalDay(utc("2026-03-30T10:00:00Z"), "Europe/Paris")).toBe(utc("2026-03-29T22:00:00Z"));
  });

  it("uses the server's own zone for null", () => {
    const now = utc("2026-10-14T12:00:00Z");
    const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(startOfLocalDay(now, null)).toBe(startOfLocalDay(now, own));
  });
});

describe("rangeStart", () => {
  const now = utc("2026-10-14T12:00:00Z");
  it("is today's midnight, six days before it, and twenty-nine days before it", () => {
    expect(rangeStart(now, "today", "UTC")).toBe(utc("2026-10-14T00:00:00Z"));
    expect(rangeStart(now, "7d", "UTC")).toBe(utc("2026-10-08T00:00:00Z"));
    expect(rangeStart(now, "30d", "UTC")).toBe(utc("2026-09-15T00:00:00Z"));
  });

  it("counts calendar days across the clock change", () => {
    expect(rangeStart(utc("2026-10-27T12:00:00Z"), "7d", "Europe/Paris")).toBe(utc("2026-10-20T22:00:00Z"));
  });
});
