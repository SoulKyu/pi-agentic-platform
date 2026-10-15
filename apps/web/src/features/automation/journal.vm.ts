import type { FireVerdict, FireView } from "@pap/contracts";
import { formatCost, formatDuration, type ChipTone } from "@pap/ui";
import { getLocale, plural, t, type Locale } from "../../i18n/index.ts";
import { shown } from "./board.vm.ts";

export type JournalFilter = "all" | "fired" | "refused";

/** Board 11's chips: a fire that started is ok, a refusal by a gate is att, a failure or an outsider's attempt is err. */
const VERDICT_CHIP: Readonly<Record<FireVerdict, ChipTone>> = {
  fired: "ok",
  dedup: "mut",
  precheck: "mut",
  budget: "att",
  paused: "att",
  disabled: "mut",
  throttle: "mut",
  queue_full: "att",
  unauthorized: "err",
  too_large: "err",
  bad_payload: "err",
  resolved: "mut",
  missed: "mut",
  error: "err",
};

export const verdictTone = (verdict: FireVerdict): ChipTone => VERDICT_CHIP[verdict];

/** The chip's word; a collapsed line says how many times ("precheck ×12"). A 401 line counts in its sentence instead. */
export function verdictLabel(entry: FireView): string {
  const word = t(`automation.verdict.${entry.verdict}`);
  return entry.count > 1 && entry.verdict !== "unauthorized" ? `${word} ×${entry.count}` : word;
}

export const keeps = (entry: FireView, filter: JournalFilter): boolean =>
  filter === "all" || (filter === "fired") === (entry.verdict === "fired");

/**
 * The detail cell. A 401 line stores the auth mode and a count, not a sentence (M10R161): the sentence is built here.
 * A missed line stores its count. Anything else is the payload's or the precheck's own first line: untrusted, so it is
 * written out (hidden characters visible) and clipped, and drawn as a text node.
 */
export function detailText(entry: FireView): string {
  if (entry.verdict === "unauthorized") {
    const mode = entry.detail === "hmac" ? "hmac" : "secret";
    return plural(
      getLocale(),
      mode === "hmac" ? "automation.journal.unauthorized.hmac" : "automation.journal.unauthorized.secret",
      entry.count,
    );
  }
  if (entry.verdict === "missed" && entry.detail !== null && /^\d{1,6}\+?$/.test(entry.detail)) {
    const count = Number.parseInt(entry.detail, 10);
    return entry.detail.endsWith("+")
      ? t("automation.journal.missedCapped", { count })
      : plural(getLocale(), "automation.journal.missed", count);
  }
  return entry.detail === null ? "" : shown(entry.detail, "detail");
}

/** Newest first; a page loaded twice (a refresh while "Load more" is on screen) never repeats a line. */
export function mergePage(current: readonly FireView[], page: readonly FireView[]): FireView[] {
  const seen = new Set(current.map((entry) => entry.id));
  return [...current, ...page.filter((entry) => !seen.has(entry.id))];
}

/** The `before` cursor of the next page: the oldest line loaded. */
export const cursorOf = (entries: readonly FireView[]): number | undefined => entries.at(-1)?.id;

function clock(ms: number, now: number, locale: Locale): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { timeStyle: "medium", hourCycle: "h23" }
    : { dateStyle: "short", timeStyle: "short", hourCycle: "h23" };
  return new Intl.DateTimeFormat(locale, options).format(ms);
}

/** The time of a line, or the range of a collapsed one ("09:00:00 → 13:00:00"). */
export function whenText(entry: FireView, now: number, locale: Locale): string {
  return entry.count > 1 && entry.firstAt !== entry.at
    ? `${clock(entry.firstAt, now, locale)} → ${clock(entry.at, now, locale)}`
    : clock(entry.at, now, locale);
}

export const durationText = (entry: FireView): string =>
  entry.durationMs === null ? "—" : formatDuration(entry.durationMs);

export const costText = (entry: FireView): string =>
  entry.costUsd === null ? "—" : formatCost(entry.costUsd);
