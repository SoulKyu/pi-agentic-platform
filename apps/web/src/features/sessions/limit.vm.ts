import type { LimitView } from "@pap/contracts";
import type { Locale } from "../../i18n/index.ts";

export type LimitLabel =
  { readonly key: "usage.limit.resets"; readonly time: string } | { readonly key: "usage.limit.reached" };

interface LabelOptions {
  readonly locale: Locale;
  readonly now: number;
  /** An IANA zone; the browser's own when absent. */
  readonly timeZone?: string;
}

const dayOf = (at: number, zone: string | undefined): string =>
  new Intl.DateTimeFormat("en-CA", {
    ...(zone === undefined ? {} : { timeZone: zone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

/** "Resets 14:30" in the browser's zone (with the weekday when it is not today there), or "Limit reached" without a time. */
export function limitLabel(limit: Pick<LimitView, "resetAt">, options: LabelOptions): LimitLabel {
  const { resetAt } = limit;
  if (resetAt === null) return { key: "usage.limit.reached" };
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  const clock = new Intl.DateTimeFormat(options.locale, {
    ...zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetAt);
  const sameDay = dayOf(resetAt, options.timeZone) === dayOf(options.now, options.timeZone);
  if (sameDay) return { key: "usage.limit.resets", time: clock };
  const weekday = new Intl.DateTimeFormat(options.locale, { ...zone, weekday: "short" }).format(resetAt);
  return { key: "usage.limit.resets", time: `${weekday} ${clock}` };
}
