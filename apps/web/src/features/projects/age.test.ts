import { describe, expect, it } from "vitest";
import { sidebarEn, sidebarFr } from "../../i18n/catalog/sidebar.ts";
import type { Translate } from "../../i18n/index.ts";
import { formatAge } from "./age.ts";

const NOW = 1_800_000_000_000;
const over =
  (catalog: Readonly<Record<string, string>>): Translate =>
  (key, vars = {}) =>
    (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name]));
const en = over(sidebarEn);
const fr = over(sidebarFr);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("formatAge", () => {
  it("reads fixed units in English", () => {
    expect([
      formatAge(NOW, NOW - 30_000, en),
      formatAge(NOW, NOW - 5 * MIN, en),
      formatAge(NOW, NOW - 3 * HOUR, en),
      formatAge(NOW, NOW - 2 * DAY, en),
      formatAge(NOW, NOW - 30 * DAY, en),
    ]).toEqual(["now", "5 min", "3 h", "2 d", "4 wk"]);
  });

  it("reads fixed units in French", () => {
    expect([
      formatAge(NOW, NOW - 30_000, fr),
      formatAge(NOW, NOW - 5 * MIN, fr),
      formatAge(NOW, NOW - 3 * HOUR, fr),
      formatAge(NOW, NOW - 2 * DAY, fr),
      formatAge(NOW, NOW - 30 * DAY, fr),
    ]).toEqual(["maintenant", "5 min", "3 h", "2 j", "4 sem."]);
  });

  it("switches unit at each boundary and reads a future time as now", () => {
    expect([
      formatAge(NOW, NOW - 59_999, en),
      formatAge(NOW, NOW - MIN, en),
      formatAge(NOW, NOW - (HOUR - 1), en),
      formatAge(NOW, NOW - HOUR, en),
      formatAge(NOW, NOW - (DAY - 1), en),
      formatAge(NOW, NOW - DAY, en),
      formatAge(NOW, NOW - (14 * DAY - 1), en),
      formatAge(NOW, NOW - 14 * DAY, en),
      formatAge(NOW, NOW + 5 * MIN, en),
    ]).toEqual(["now", "1 min", "59 min", "1 h", "23 h", "1 d", "13 d", "2 wk", "now"]);
  });
});
