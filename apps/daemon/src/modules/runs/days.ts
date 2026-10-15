import type { UsageRange } from "@pap/contracts";

const DAY_MS = 86_400_000;
const DAYS_BACK: Record<UsageRange, number> = { today: 0, "7d": 6, "30d": 29 };

/** The zone name when the setting has none: the server's own. */
export const serverTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** What a zone's clock reads at `instant`, written as if it were UTC: the difference to `instant` is the zone's offset then. */
function wallClockAsUtc(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(instant);
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
  return Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
  );
}

/** Local midnight of the day `now` falls in, in `timeZone` (null: the server's own), as epoch milliseconds. */
export function startOfLocalDay(now: number, timeZone: string | null): number {
  const zone = timeZone ?? serverTimeZone();
  const instant = Math.floor(now / 1000) * 1000;
  const midnightAsUtc = Math.floor(wallClockAsUtc(instant, zone) / DAY_MS) * DAY_MS;
  // The offset at midnight can differ from the offset now (a clock change in between): ask again at the first guess.
  const guess = midnightAsUtc - (wallClockAsUtc(instant, zone) - instant);
  return midnightAsUtc - (wallClockAsUtc(guess, zone) - guess);
}

/** The first instant of a range: local midnight of today, of six days ago (`7d`) or of twenty-nine days ago (`30d`). */
export function rangeStart(now: number, range: UsageRange, timeZone: string | null): number {
  const today = startOfLocalDay(now, timeZone);
  // Noon of the target day stays on that day whatever a clock change adds or takes away.
  return startOfLocalDay(today + DAY_MS / 2 - DAYS_BACK[range] * DAY_MS, timeZone);
}
