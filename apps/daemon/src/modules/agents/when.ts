const MINUTE = 60_000;
/** A reminder is set at least this far ahead and at most this far (M11R80). */
export const REMIND_MIN_MS = 15 * MINUTE;
export const REMIND_MAX_MS = 30 * 24 * 60 * MINUTE;

const UNIT_MS = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE } as const;
const RELATIVE = /^([1-9]\d{0,4})([mhd])$/;
// `T`, an optional seconds field with up to three decimals, and an offset that is always written (`Z` or `+02:00`).
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** The instant an ISO 8601 text with an offset names; null when a field is out of range (a 30th of February). */
function isoInstant(text: string): number | null {
  const parts = ISO.exec(text);
  if (!parts) return null;
  const [year, month, day, hour, minute] = parts.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = Number(parts[6] ?? 0);
  const millis = Number((parts[7] ?? "").padEnd(3, "0"));
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const real =
    wall.getUTCFullYear() === year &&
    wall.getUTCMonth() === month - 1 &&
    wall.getUTCDate() === day &&
    hour < 24 &&
    minute < 60 &&
    second < 60;
  if (!real) return null;
  const zone = parts[8] as string;
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    offset = (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes) * MINUTE;
  }
  return wall.getTime() + millis - offset;
}

/**
 * The instant a reminder's `when` names (M11R80), or null: `<n>m`, `<n>h` or `<n>d` from `now`, or ISO 8601 with an
 * offset. Nothing else is read ("tomorrow", "9am", a time without an offset, seconds). Null too when the instant is less
 * than 15 minutes or more than 30 days ahead. Pure: `now` is the kernel Clock's.
 */
export function parseWhen(text: string, now: number): number | null {
  const relative = RELATIVE.exec(text);
  const at = relative
    ? now + Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS]
    : isoInstant(text);
  if (at === null || at - now < REMIND_MIN_MS || at - now > REMIND_MAX_MS) return null;
  return at;
}
