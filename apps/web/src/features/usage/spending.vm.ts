import { USAGE_RANGES, type UsageSummary } from "@pap/contracts";
import type { MessageKey } from "../../i18n/index.ts";

export const SPENDING_RANGES = USAGE_RANGES;

/** Dollars in the owner's locale. Cents at least, up to four decimals, so a run that cost a fraction of a cent still shows. */
export function formatUsd(amount: number, locale: string): string {
  const value = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const format = (shown: number): string =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(shown);
  return value > 0 && Number(value.toFixed(4)) === 0 ? `<${format(0.0001)}` : format(value);
}

export const formatTokens = (count: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number.isFinite(count) ? count : 0);

/** The share of the daily budget spent, 0 to 1. Null without a budget: there is nothing to measure against. */
export function meterFraction(todayUsd: number, budgetUsd: number | null): number | null {
  if (budgetUsd === null) return null;
  if (budgetUsd === 0) return 1;
  return Math.min(1, Math.max(0, todayUsd / budgetUsd));
}

type Billing = UsageSummary["byModel"][number]["billing"];

/** A subscription has no bill per token: the figure is what the API would have charged. */
export const billingLabelKey = (billing: Billing): MessageKey | null =>
  billing === "subscription" ? "settingsAutomation.billing.subscription" : null;

const ORIGINS = ["user", "trigger", "resume", "extension"] as const;

export const originLabelKey = (origin: string): MessageKey | null =>
  (ORIGINS as readonly string[]).includes(origin)
    ? (`settingsAutomation.origin.${origin as (typeof ORIGINS)[number]}` as const)
    : null;

export function orderedOrigins<Row extends { readonly origin: string }>(rows: readonly Row[]): Row[] {
  const rank = (origin: string): number => {
    const index = (ORIGINS as readonly string[]).indexOf(origin);
    return index === -1 ? ORIGINS.length : index;
  };
  return [...rows].sort((a, b) => rank(a.origin) - rank(b.origin) || a.origin.localeCompare(b.origin));
}
