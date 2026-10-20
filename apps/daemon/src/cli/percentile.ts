/** Nearest rank: the smallest value with at least `p` percent of the values at or below it. `sorted` is not empty. */
export const percentile = (sorted: readonly number[], p: number): number =>
  sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
