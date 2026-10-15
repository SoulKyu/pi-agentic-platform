import { z } from "zod";
import { defineMethod } from "./define.ts";

/** The providers whose official usage endpoint pap knows (M10R109). Any other id answers `unsupported`. */
export const PROVIDER_USAGE_IDS = [
  "openai-codex",
  "deepseek",
  "openrouter",
  "moonshotai",
  "moonshotai-cn",
  "minimax",
  "minimax-cn",
  "vercel-ai-gateway",
  "opencode-go",
  "kimi-coding",
] as const;
export type ProviderUsageId = (typeof PROVIDER_USAGE_IDS)[number];
export const isProviderUsageId = (value: string): value is ProviderUsageId =>
  (PROVIDER_USAGE_IDS as readonly string[]).includes(value);

export const USAGE_BUCKETS_MAX = 32;
export const USAGE_METRICS_MAX = 32;
export const USAGE_TEXT_MAX = 64;

const Text = z.string().min(1).max(USAGE_TEXT_MAX);
const Amount = z.number().finite().nonnegative();
export const UsageUnit = z.enum(["percent", "currency", "count"]);

/** One quota window or limit. Every field is parsed from a provider's answer, so each is bounded. */
export const UsageBucket = z
  .object({
    id: Text,
    label: Text,
    used: Amount.optional(),
    remaining: Amount.optional(),
    limit: Amount.optional(),
    unit: UsageUnit,
    currency: z.string().min(1).max(8).optional(),
    windowMinutes: z.number().int().positive().max(5_256_000).optional(),
    /** Seconds since the epoch. */
    resetsAt: z.number().int().nonnegative().optional(),
    period: Text.optional(),
  })
  .strict();
export type UsageBucket = z.infer<typeof UsageBucket>;

export const UsageMetric = z
  .object({
    id: Text,
    label: Text,
    value: z.union([Amount, z.string().min(1).max(USAGE_TEXT_MAX)]),
    unit: UsageUnit.optional(),
    currency: z.string().min(1).max(8).optional(),
  })
  .strict();
export type UsageMetric = z.infer<typeof UsageMetric>;

export const UsageReport = z
  .object({
    providerId: z.enum(PROVIDER_USAGE_IDS),
    providerName: Text,
    /** Milliseconds since the epoch, when the provider answered. */
    capturedAt: z.number().int().nonnegative(),
    buckets: z.array(UsageBucket).max(USAGE_BUCKETS_MAX),
    metrics: z.array(UsageMetric).max(USAGE_METRICS_MAX),
  })
  .strict();
export type UsageReport = z.infer<typeof UsageReport>;

export const ModelsUsageParams = z.object({ providerId: z.string().min(1).max(128) }).strict();

/** Failures are statuses with fixed texts in the client: nothing a provider said, nothing of a credential. */
export const ModelsUsageResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), report: UsageReport }).strict(),
  z.object({ status: z.literal("auth_unavailable") }).strict(),
  z.object({ status: z.literal("query_failed") }).strict(),
  /** An enabled extension moved the provider off its official address: no credential was resolved or sent. */
  z.object({ status: z.literal("provider_overridden") }).strict(),
  /** An enabled extension failed to load or register: refused, fail closed. */
  z.object({ status: z.literal("extensions_failed") }).strict(),
  z.object({ status: z.literal("unsupported") }).strict(),
]);
export type ModelsUsageResult = z.infer<typeof ModelsUsageResult>;

export const modelsUsageMethods = {
  // Sends the provider's stored key to its official usage endpoint, on the owner's click (M10R109, M10R110).
  "models.usage": defineMethod({
    name: "models.usage",
    permission: "pi:admin",
    idempotent: true,
    params: ModelsUsageParams,
    result: ModelsUsageResult,
    errors: ["capacity", "timeout", "helper_failed"],
  }),
} as const;
