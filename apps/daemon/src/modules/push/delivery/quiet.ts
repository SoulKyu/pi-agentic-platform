import { inQuietHours, type AutomationSettings } from "@pap/contracts";

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;

/**
 * The first whole minute at which the owner's quiet hours are over, or null when `now` is not inside a window (M12R17).
 * It asks `inQuietHours` minute by minute, so a DST jump moves the answer to the real wall-clock end, never to
 * "now plus the window's length". At most a day of minutes is scanned.
 */
export function nextQuietEnd(
  quietHours: AutomationSettings["quietHours"],
  timezone: string | null,
  now: number,
): number | null {
  if (!inQuietHours(quietHours, timezone, now)) return null;
  const start = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  for (let step = 1; step <= MINUTES_PER_DAY; step++) {
    const at = start + step * MINUTE_MS;
    if (!inQuietHours(quietHours, timezone, at)) return at;
  }
  return null;
}
