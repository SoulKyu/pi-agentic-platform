/** A stored instant as the person's own date and time; empty for a value `Date` cannot show. */
export function whenText(millis: number, locale: string): string {
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15
    ? new Date(millis).toLocaleString(locale)
    : "";
}
