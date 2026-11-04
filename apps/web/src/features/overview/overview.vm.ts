import type { OverviewActivity, OverviewAsk, OverviewBox, OverviewState } from "@pap/contracts";
import type { ChipTone } from "@pap/ui";
import type { Locale, Translate } from "../../i18n/index.ts";
import { formatGb } from "../../lib/format-gb.ts";

const DAY = 24 * 60 * 60_000;

export type ActiveBox = OverviewBox & { readonly state: Exclude<OverviewState, "stopped"> };

/** The daemon already ordered the list (R1); this only tells a card from a stopped-strip row. */
export const isActive = (box: OverviewBox): box is ActiveBox => box.state !== "stopped";

/** The daemon's word for a box, as a chip tone: attention, failure, and the agent's running colour twice. */
export const STATE_TONE: Readonly<Record<Exclude<OverviewState, "stopped">, ChipTone>> = {
  waiting: "att",
  failed: "err",
  running: "run",
  starting: "run",
};

/** The VM phase, `PhaseChip`-like: a stopped or paused box is neutral, never red. */
export const PHASE_TONE: Readonly<Record<NonNullable<OverviewBox["phase"]>, ChipTone>> = {
  stopped: "mut",
  starting: "run",
  running: "ok",
  paused: "mut",
  stopping: "mut",
};

export const sizeText = (mb: number, locale: Locale, t: Translate): string =>
  t("overview.size", { value: formatGb(mb, locale) });

export function memoryText(usedMb: number, maxMb: number, locale: Locale, t: Translate): string {
  return t("overview.memory.figure", {
    used: formatGb(usedMb, locale),
    max: formatGb(maxMb, locale),
  });
}

export const percentText = (value: number, t: Translate): string => t("overview.percent", { value });

/** HH:MM on a 24 h clock in every locale (spec 3.9): a fixed time of day never ticks (DESIGN.md 7.2). */
const timeOfDay = (at: number, locale: Locale): string =>
  new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

/** "Task · Tidy · since 14:02": an empty title (an agent's thread has no name) leaves no empty segment. */
export function activityLine(activity: OverviewActivity, locale: Locale, t: Translate): string {
  const parts = [t(`overview.activity.${activity.kind}`)];
  if (activity.title !== "") parts.push(activity.title);
  if (activity.since !== null)
    parts.push(t("overview.card.since", { time: timeOfDay(activity.since, locale) }));
  return parts.join(" · ");
}

/** The time of day today; "tomorrow 08:00" the next calendar day; a weekday and time later. */
export function nextRunText(at: number, now: number, locale: Locale, t: Translate): string {
  const time = timeOfDay(at, locale);
  const day = (value: number) => new Date(value).setHours(0, 0, 0, 0);
  const apart = Math.round((day(at) - day(now)) / DAY);
  if (apart <= 0) return time;
  if (apart === 1) return t("overview.card.tomorrow", { time });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at);
  return `${weekday} ${time}`;
}

const INBOX_ASKS = ["agent_approve", "task_needs_input", "secret_request"] as const;
const isInboxAsk = (kind: string): kind is (typeof INBOX_ASKS)[number] =>
  (INBOX_ASKS as readonly string[]).includes(kind);

/** R4: an Inbox item shows its category word and `detail ?? triggerName`; a session dialog says where it waits. */
export function askWords(ask: OverviewAsk, t: Translate): { category: string; detail: string } {
  if (ask.source === "session") return { category: t("overview.ask.session"), detail: ask.title };
  const { item } = ask;
  return {
    category: isInboxAsk(item.kind) ? t(`overview.ask.${item.kind}`) : "",
    detail: item.detail ?? item.triggerName,
  };
}

/** "Next 18:00 · Evening pulse": the card's and the stopped row's next-run line. */
export const nextRunLine = (
  run: NonNullable<OverviewBox["nextRun"]>,
  now: number,
  locale: Locale,
  t: Translate,
) => t("overview.card.next", { time: nextRunText(run.at, now, locale, t), name: run.name });
