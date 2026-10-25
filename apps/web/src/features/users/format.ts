/** A stored instant in the person's own date and time; empty for a value `Date` cannot show. */
export function whenText(millis: number, locale: string): string {
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
    ? new Date(millis).toLocaleString(locale)
    : "";
}

/** Dollars in the owner's locale, cents at least, so a small spend still shows. */
export const formatUsd = (amount: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number.isFinite(amount) && amount > 0 ? amount : 0);
