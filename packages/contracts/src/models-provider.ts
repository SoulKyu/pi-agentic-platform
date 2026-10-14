import { z } from "zod";
import { defineMethod } from "./define.ts";

const ProviderId = z.string().min(1).max(128);
const ModelId = z.string().min(1).max(256);

/** What a failed provider request is reduced to: a status class, never the provider's body or message (M7R66). */
export const PROVIDER_STATUS_CLASSES = ["http_4xx", "http_5xx", "network", "timeout"] as const;
export const ProviderStatusClass = z.enum(PROVIDER_STATUS_CLASSES);

/** The most models one discovery answers (the same bound as the overview's list). */
export const DISCOVERED_MODELS_MAX = 2000;
export const PRICING_ENTRIES_MAX = 10;

/** Only these three fields are copied from a discovered entry: gateways use the others for different things (pi-web #856). */
export const DiscoveredModel = z
  .object({
    id: ModelId,
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
  })
  .strict();

export const DiscoverParams = z.object({ provider: ProviderId }).strict();
/** `code` set: the request failed and `models` is empty. */
export const ModelsDiscoverResult = z
  .object({
    models: z.array(DiscoveredModel).max(DISCOVERED_MODELS_MAX),
    code: ProviderStatusClass.optional(),
    /** The list was cut to stay within the byte budget (the M2R54 pattern). */
    truncated: z.boolean().optional(),
  })
  .strict();

export type ModelsDiscoverResult = z.infer<typeof ModelsDiscoverResult>;

export const TestModelParams = z.object({ provider: ProviderId, modelId: ModelId }).strict();
export const ModelsTestResult = z
  .object({
    ok: z.boolean(),
    latencyMs: z.number().int().nonnegative().max(3_600_000),
    code: ProviderStatusClass.optional(),
  })
  .strict();

export type ModelsTestResult = z.infer<typeof ModelsTestResult>;

export const PricingParams = z.object({ provider: ProviderId.optional(), modelId: ModelId }).strict();
const Price = z.number().finite().nonnegative();
export const PricingEntry = z
  .object({
    provider: ProviderId,
    id: ModelId,
    input: Price.optional(),
    output: Price.optional(),
    cacheRead: Price.optional(),
    cacheWrite: Price.optional(),
    contextWindow: Price.optional(),
  })
  .strict();
export type PricingEntry = z.infer<typeof PricingEntry>;
export const ModelsPricingResult = z
  .object({ entries: z.array(PricingEntry).max(PRICING_ENTRIES_MAX) })
  .strict();

export type ModelsPricingResult = z.infer<typeof ModelsPricingResult>;

/** The most models the extracted price map holds (models.dev lists a few thousand). */
export const PRICING_CATALOG_MAX_ENTRIES = 20_000;
/**
 * What the helper answers (MC34): the entries asked for and, when it fits, the extracted map of every model's numeric
 * prices, which the daemon keeps for an hour and answers later questions from. No map: nothing is kept.
 */
export const HelperPricingResult = z
  .object({
    entries: z.array(PricingEntry).max(PRICING_ENTRIES_MAX),
    catalog: z.array(PricingEntry).max(PRICING_CATALOG_MAX_ENTRIES).optional(),
  })
  .strict();
export type HelperPricingResult = z.infer<typeof HelperPricingResult>;

/** The entries of `catalog` for a model id (and a provider, when given), at most ten. */
export function pickPrices(
  catalog: readonly PricingEntry[],
  provider: string | undefined,
  modelId: string,
): PricingEntry[] {
  return catalog
    .filter((entry) => entry.id === modelId && (provider === undefined || entry.provider === provider))
    .slice(0, PRICING_ENTRIES_MAX);
}

const PROVIDER_CALL_ERRORS = [
  "not_found",
  "capacity",
  "timeout",
  "helper_failed",
  "config_invalid",
  "config_path_refused",
] as const;

export const modelsProviderMethods = {
  // Sends the provider's key to its base URL: the password step-up first (owner c3, M7R133).
  "models.discover": defineMethod({
    name: "models.discover",
    permission: "pi:admin",
    idempotent: false,
    params: DiscoverParams,
    result: ModelsDiscoverResult,
    errors: ["step_up_required", ...PROVIDER_CALL_ERRORS],
  }),
  "models.test": defineMethod({
    name: "models.test",
    permission: "pi:admin",
    idempotent: false,
    params: TestModelParams,
    result: ModelsTestResult,
    errors: [...PROVIDER_CALL_ERRORS],
  }),
  // `forbidden` while the owner's `modelsDevPricing` switch is off: no request is made then (M7R138).
  "models.pricing": defineMethod({
    name: "models.pricing",
    permission: "pi:read",
    idempotent: true,
    params: PricingParams,
    result: ModelsPricingResult,
    errors: ["forbidden", "capacity", "timeout", "helper_failed"],
  }),
} as const;
