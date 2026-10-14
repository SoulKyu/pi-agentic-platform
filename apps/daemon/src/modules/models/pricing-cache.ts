import type { PricingEntry } from "@pap/contracts";

/** How long the extracted price map is kept (M7R67, MC34). */
export const PRICING_CACHE_MS = 60 * 60 * 1000;
/** A map over this many serialised bytes is not kept at all (MC34). */
export const PRICING_CACHE_MAX_BYTES = 1024 * 1024;

type Catalog = ReadonlyArray<PricingEntry>;

export interface PricingCache {
  /** The kept map, or undefined when none is kept or it is older than an hour. */
  get(now: number): Catalog | undefined;
  /** Keeps `catalog` for an hour, replacing the last one; a map over the byte cap is not kept. */
  set(catalog: Catalog, now: number): void;
}

/**
 * One map, replaced by the next and never grown: bounded by construction. It holds model ids and numeric price fields
 * only, from models.dev, so it is not owner data; the opt-in is checked before it is read. Whatever a caller asks,
 * models.dev is downloaded at most once an hour.
 */
export function createPricingCache(): PricingCache {
  let kept: { catalog: Catalog; expiresAt: number } | undefined;
  return {
    get: (now) => (kept && now < kept.expiresAt ? kept.catalog : undefined),
    set: (catalog, now) => {
      kept =
        Buffer.byteLength(JSON.stringify(catalog)) > PRICING_CACHE_MAX_BYTES
          ? undefined
          : { catalog, expiresAt: now + PRICING_CACHE_MS };
    },
  };
}
