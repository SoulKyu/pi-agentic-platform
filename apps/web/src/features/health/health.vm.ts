import type { HealthEvent } from "@pap/contracts";
import { t, type Locale, type MessageKey } from "../../i18n/index.ts";

const FEED_STATUS = /^feed_status_(\d{3})$/;

/** The sentence of a row (spec §7): the code's own copy, `feed_status_<n>` folded to its {status} slot. */
export function codeText(event: HealthEvent): string {
  const status = FEED_STATUS.exec(event.code)?.[1];
  // The daemon validated the code against HEALTH_TABLE, so the key exists.
  return status === undefined
    ? t(`health.code.${event.code}` as MessageKey)
    : t("health.code.feed_status", { status });
}

function clock(ms: number, now: number, locale: Locale): string {
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { timeStyle: "medium", hourCycle: "h23" }
    : { dateStyle: "short", timeStyle: "short", hourCycle: "h23" };
  return new Intl.DateTimeFormat(locale, options).format(ms);
}

/** The time of a row, the fire journal's own formatting (journal.vm.ts). */
export const whenText = (ts: number, now: number, locale: Locale): string => clock(ts, now, locale);

/** The `before` cursor of the next page: the oldest row loaded. */
export const cursorOf = (events: readonly HealthEvent[]): number | undefined => events.at(-1)?.seq;

export type SourceView =
  | { readonly label: string; readonly to: "/trigger/$id"; readonly params: { readonly id: string } }
  | { readonly label: string; readonly to: "/agents/$id"; readonly params: { readonly id: string } }
  | { readonly label: string; readonly to: "/tasks" }
  | { readonly label: string; readonly to: null };

/** The source cell (spec §5): the trigger or agent name as a link, a task id to the board, an effect as plain text. */
export function sourceOf(event: HealthEvent): SourceView {
  const source = event.sourceRef;
  if (source === null) return { label: "—", to: null };
  switch (source.kind) {
    case "trigger":
      return { label: source.name ?? source.id, to: "/trigger/$id", params: { id: source.id } };
    case "task":
      return { label: source.id, to: "/tasks" };
    case "agent":
      return { label: source.name ?? source.id, to: "/agents/$id", params: { id: source.id } };
    case "effect":
      return { label: `#${String(source.id)}`, to: null };
  }
}
