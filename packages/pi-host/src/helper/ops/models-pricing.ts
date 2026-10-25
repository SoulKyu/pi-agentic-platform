import {
  HELPER_OPS,
  type HelperPricingResult,
  PRICING_CATALOG_MAX_ENTRIES,
  PRICING_ENTRIES_MAX,
  type PricingEntry,
} from "@pap/contracts/pi-host";
import type { z } from "zod";
import { defineOp, HelperOpError, type HelperOp } from "../ops.ts";
import { deadline, readCapped, strictFetch } from "./provider-request.ts";

/** The only address this operation ever asks, and only when the owner switched the lookup on (M7R138). */
export const PRICING_URL = "https://models.dev/api.json";
export const PRICING_MAX_BYTES = 8 * 1024 * 1024;
/** The extracted map is sent to the daemon only below this many serialised bytes (MC34). */
export const PRICING_CATALOG_MAX_BYTES = 900_000;
export const PRICING_TIMEOUT_MS = 15_000;

type Entry = PricingEntry;
interface Options {
  readonly timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** A price or limit is a finite, non-negative number; anything else (a string, a negative, NaN) is left out. */
const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** One models.dev model reduced to its numeric cost and context fields: no name, no text of models.dev's reaches the client. */
function entryOf(provider: string, id: string, model: Record<string, unknown>): Entry {
  const cost = isRecord(model.cost) ? model.cost : {};
  const limit = isRecord(model.limit) ? model.limit : {};
  const fields = {
    input: amount(cost.input),
    output: amount(cost.output),
    cacheRead: amount(cost.cache_read),
    cacheWrite: amount(cost.cache_write),
    contextWindow: amount(limit.context),
  };
  return {
    provider,
    id,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  };
}

/**
 * Every model of models.dev reduced to its numeric prices (MC34), and the entries for the one asked about. The map is
 * left out (`catalog` undefined) when it would weigh over 900 000 bytes or hold over 20 000 models: the helper's record
 * stops at 1 MiB, and the daemon then keeps nothing and asks again next time.
 */
function extract(
  catalog: unknown,
  provider: string | undefined,
  modelId: string,
): { entries: Entry[]; catalog?: Entry[] } {
  if (!isRecord(catalog)) throw new HelperOpError("failed", "unexpected catalog shape");
  const entries: Entry[] = [];
  const all: Entry[] = [];
  let bytes = 2;
  let fits = true;
  for (const [providerId, record] of Object.entries(catalog)) {
    if (!isRecord(record) || !isRecord(record.models)) continue;
    for (const [id, model] of Object.entries(record.models)) {
      if (!isRecord(model) || id.length > 256) continue;
      const entry = entryOf(providerId.slice(0, 128), id, model);
      if (
        id === modelId &&
        (provider === undefined || providerId === provider) &&
        entries.length < PRICING_ENTRIES_MAX
      )
        entries.push(entry);
      if (!fits) continue;
      bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes > PRICING_CATALOG_MAX_BYTES || all.length >= PRICING_CATALOG_MAX_ENTRIES) fits = false;
      else all.push(entry);
    }
  }
  return fits ? { entries, catalog: all } : { entries };
}

/**
 * Fetches models.dev's catalog (8 MiB cap, 15 s) and answers the entries for one model (M7R67). It runs only when the
 * daemon asked, and the daemon asks only with the owner's switch on. The request carries no header and no cookie, follows
 * no redirect, and a failure's own text never leaves (the detail is a fixed phrase).
 */
export function createPricingOp(
  fetchImpl: typeof fetch = strictFetch,
  options: Options = {},
): HelperOp<z.infer<(typeof HELPER_OPS)["models.pricing"]["params"]>, HelperPricingResult> {
  const timeoutMs = options.timeoutMs ?? PRICING_TIMEOUT_MS;
  return {
    params: HELPER_OPS["models.pricing"].params,
    run: async (params, ctx) => {
      const limit = deadline(ctx.signal, timeoutMs);
      try {
        const response = await fetchImpl(PRICING_URL, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          signal: limit.signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new HelperOpError("failed", "models.dev answered with an error status");
        }
        const text = await readCapped(response, PRICING_MAX_BYTES);
        if (text === null) throw new HelperOpError("failed", "models.dev answer over the size cap");
        let catalog: unknown;
        try {
          catalog = JSON.parse(text);
        } catch {
          throw new HelperOpError("failed", "models.dev answer is not JSON");
        }
        return extract(catalog, params.provider, params.modelId);
      } catch (error) {
        if (error instanceof HelperOpError) throw error;
        throw new HelperOpError(
          "failed",
          limit.timedOut() ? "models.dev timed out" : "models.dev request failed",
        );
      } finally {
        limit.dispose();
      }
    },
  };
}

export const modelsPricing = createPricingOp();
export const modelsPricingOp = defineOp(modelsPricing);
