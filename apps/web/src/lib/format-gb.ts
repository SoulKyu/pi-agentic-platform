const MB_PER_GB = 1024;

/** MB / 1024, always one decimal, with the locale's separator (the unit comes from the caller's own catalog key). */
export function formatGb(mb: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
    mb / MB_PER_GB,
  );
}
