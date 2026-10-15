/**
 * The next occurrence of a parsed RRULE in a time zone (M10R60). Its own module so that the code which only parses a
 * rule (the schema, in the initial bundle) does not carry the zone arithmetic: only the scheduler and the trigger
 * editor's preview use it. Pure: no clock, no I/O.
 */
import type { ParsedRrule } from "./rrule.ts";

// ---- wall clock and offsets ----

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SEARCH_DAYS = 8;
const MAX_OCCURRENCES = 10;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The wall clock of an instant in the zone, read as if it were UTC. */
function wallAsUtc(timeZone: string, instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatterOf(timeZone).formatToParts(instant))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(
    parts.year as number,
    (parts.month as number) - 1,
    parts.day as number,
    parts.hour as number,
    parts.minute as number,
    parts.second as number,
  );
}

/** Offset of the zone from UTC at an instant, in ms. */
const offsetAt = (timeZone: string, instant: number): number =>
  wallAsUtc(timeZone, instant) - Math.floor(instant / 1000) * 1000;

/** First instant in (low, high] at which the offset is no longer the one at `low`. */
function transitionBetween(timeZone: string, low: number, high: number): number {
  const before = offsetAt(timeZone, low);
  let lo = low;
  let hi = high;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (offsetAt(timeZone, mid) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The instants at which the wall clock shows `wall` (read as UTC): none is impossible, so a time inside a spring-forward
 * gap becomes the first instant after the gap; two instants come back for a time that exists twice.
 */
function instantsOf(timeZone: string, wall: number): number[] {
  const around = [offsetAt(timeZone, wall - DAY), offsetAt(timeZone, wall + DAY)];
  const offsets = [...new Set(around)];
  const instants = offsets.map((offset) => wall - offset).filter((t) => offsetAt(timeZone, t) === wall - t);
  if (instants.length > 0) return [...new Set(instants)].sort((a, b) => a - b);
  const [first, second] = offsets.map((offset) => wall - offset) as [number, number?];
  if (second === undefined) return [first];
  return [transitionBetween(timeZone, Math.min(first, second), Math.max(first, second))];
}

/** The wall-clock times (minutes of the day) a rule fires at on a local date with this weekday (0 = Monday). */
function minutesOfDay(rule: ParsedRrule, weekday: number): number[] {
  switch (rule.freq) {
    case "MINUTELY": {
      const all: number[] = [];
      for (let minute = 0; minute < 1440; minute += rule.interval) all.push(minute);
      return all;
    }
    case "HOURLY": {
      const all: number[] = [];
      for (let hour = 0; hour < 24; hour += rule.interval)
        for (const minute of rule.minutes) all.push(hour * 60 + minute);
      return all;
    }
    case "DAILY":
      return rule.hours.map((hour) => hour * 60 + rule.minute);
    case "WEEKLY":
      return rule.days.includes(weekday) ? rule.hours.map((hour) => hour * 60 + rule.minute) : [];
  }
}

/** MINUTELY and HOURLY fire at both instants of a repeated hour (as cron does); DAILY and WEEKLY at the earlier. */
const bothInstants = (rule: ParsedRrule): boolean => rule.freq === "MINUTELY" || rule.freq === "HOURLY";

/** The smallest instant after `after` whose wall clock in `timeZone` matches the rule; null after 8 days without one. */
export function nextOccurrence(rule: ParsedRrule, timeZone: string, after: number): number | null {
  const start = wallAsUtc(timeZone, after);
  const firstDay = Math.floor(start / DAY) * DAY - DAY;
  for (let step = 0; step < SEARCH_DAYS + 2; step++) {
    const midnight = firstDay + step * DAY;
    const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
    const times = minutesOfDay(rule, weekday);
    if (times.length === 0) continue;
    const offset = offsetAt(timeZone, midnight - DAY);
    const steady = offset === offsetAt(timeZone, midnight + 2 * DAY);
    let best: number | null = null;
    for (const minute of times) {
      const wall = midnight + minute * MINUTE;
      const instants = steady ? [wall - offset] : instantsOf(timeZone, wall);
      const wanted = bothInstants(rule) ? instants : instants.slice(0, 1);
      for (const instant of wanted) if (instant > after && (best === null || instant < best)) best = instant;
    }
    if (best !== null) return best;
  }
  return null;
}

/** Up to `count` (at most 10) occurrences after `after`, ascending. */
export function nextOccurrences(rule: ParsedRrule, timeZone: string, after: number, count: number): number[] {
  const found: number[] = [];
  let from = after;
  while (found.length < Math.min(count, MAX_OCCURRENCES)) {
    const next = nextOccurrence(rule, timeZone, from);
    if (next === null) break;
    found.push(next);
    from = next;
  }
  return found;
}
