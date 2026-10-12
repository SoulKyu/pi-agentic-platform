import type { Translate } from "./index.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** A compact age with fixed units ("now", "5 min", "3 h", "2 d", "4 wk"); a time in the future reads "now". */
export function formatAge(now: number, then: number, t: Translate): string {
  const elapsed = now - then;
  if (elapsed < MINUTE) return t("sidebar.age.now");
  if (elapsed < HOUR) return t("sidebar.age.min", { n: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return t("sidebar.age.hour", { n: Math.floor(elapsed / HOUR) });
  if (elapsed < 2 * WEEK) return t("sidebar.age.day", { n: Math.floor(elapsed / DAY) });
  return t("sidebar.age.week", { n: Math.floor(elapsed / WEEK) });
}
