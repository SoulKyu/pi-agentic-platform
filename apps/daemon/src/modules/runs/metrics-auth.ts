import { createHash, timingSafeEqual } from "node:crypto";

// The shape lives in the kernel's config, which checks it at boot; the module re-exports it for its own tests.
export { METRICS_TOKEN } from "../../kernel/config.ts";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export function metricsAuthorized(authorization: string | undefined, token: string): boolean {
  const given = /^Bearer ([!-~]{1,256})$/.exec(authorization ?? "")?.[1];
  return given !== undefined && timingSafeEqual(digest(given), digest(token));
}

/**
 * At most `max` distinct values of a label, chosen the same way at every scrape (RT-23): the `max` with the highest
 * weight (cost), ties by value; every other value reads `other`. A series never flips between its name and `other`
 * unless its rank changes.
 */
export function topLabels(weights: ReadonlyMap<string, number>, max: number): (value: string) => string {
  const kept = new Set(
    [...weights.entries()]
      .sort(([a, wa], [b, wb]) => wb - wa || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, max)
      .map(([value]) => value),
  );
  return (value) => (kept.has(value) ? value : "other");
}
