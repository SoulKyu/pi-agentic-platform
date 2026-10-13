import { describe, expect, it } from "vitest";
import { snoozeTimes, toLocalInput } from "./snooze.ts";

describe("snoozeTimes", () => {
  it("an hour, tomorrow at 9:00 and next Monday at 9:00, in local time", () => {
    const thursday = new Date(2026, 9, 15, 16, 30); // Thursday 15 October 2026, 16:30
    expect(snoozeTimes(thursday)).toEqual({
      hour: thursday.getTime() + 3_600_000,
      tomorrow: new Date(2026, 9, 16, 9, 0).getTime(),
      nextWeek: new Date(2026, 9, 19, 9, 0).getTime(),
    });
    const monday = new Date(2026, 9, 19, 8, 0);
    expect(snoozeTimes(monday).nextWeek).toBe(new Date(2026, 9, 26, 9, 0).getTime());
  });

  it("next week from a Sunday is the next day, across a month end", () => {
    const sunday = new Date(2026, 9, 25, 23, 0);
    expect(snoozeTimes(sunday).nextWeek).toBe(new Date(2026, 9, 26, 9, 0).getTime());
    const friday = new Date(2026, 9, 30, 10, 0);
    expect(snoozeTimes(friday).tomorrow).toBe(new Date(2026, 9, 31, 9, 0).getTime());
    expect(snoozeTimes(friday).nextWeek).toBe(new Date(2026, 10, 2, 9, 0).getTime());
  });
});

describe("toLocalInput", () => {
  it("writes a time as the local value a datetime-local field holds", () => {
    expect(toLocalInput(new Date(2026, 0, 5, 7, 3).getTime())).toBe("2026-01-05T07:03");
  });
});
