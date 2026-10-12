/** DESIGN.md §11: costs as $0.00 (the caller labels provider cost or API-equivalent). */
export function formatCost(usd: number): string {
  const value = Number.isFinite(usd) ? usd : 0;
  return `$${Math.max(0, Math.round(value * 100) / 100).toFixed(2)}`;
}

/** DESIGN.md §11: 00:07 under a minute, 3m40 under an hour, 1h05 above. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  if (total < 60) return `00:${String(total).padStart(2, "0")}`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0
    ? `${hours}h${String(minutes).padStart(2, "0")}`
    : `${minutes}m${String(total % 60).padStart(2, "0")}`;
}

/** DESIGN.md §11: +214 −38, with U+2212 for the minus. */
export function formatDiffCounts(added: number, removed: number): string {
  const count = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
  return `+${count(added)} −${count(removed)}`;
}
