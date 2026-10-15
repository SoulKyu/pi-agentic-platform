import { z } from "zod";
import { defineMethod } from "./define.ts";
import { Cursor } from "./frames.ts";

export const USAGE_RANGES = ["today", "7d", "30d"] as const;
export const UsageRange = z.enum(USAGE_RANGES);
export type UsageRange = z.infer<typeof UsageRange>;

/** The most `byModel` rows the answer carries before the rest is summed into one `other` row (M10R90). */
export const USAGE_TOP_MODELS = 50;

const UsageTotals = z.object({
  /** Pi's price of the tokens: the provider's cost for an API key, the API-equivalent for a subscription (M10R86). */
  costUsd: z.number().min(0),
  /** Input, output, cache read and cache write tokens together. */
  tokens: z.number().int().min(0),
  runs: z.number().int().min(0),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

/** Cost and tokens of the owner's runs over a range, days counted in the automation time zone (M10R90). */
export const UsageSummary = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  timeZone: z.string().min(1).max(64),
  totals: UsageTotals,
  byOrigin: z.array(UsageTotals.extend({ origin: z.string().min(1).max(32) })).max(64),
  byModel: z
    .array(
      UsageTotals.extend({
        provider: z.string().min(1).max(64),
        model: z.string().min(1).max(128),
        billing: z.enum(["api", "subscription", "unknown"]),
      }),
    )
    .max(USAGE_TOP_MODELS + 1),
  /** Whether `GET /metrics` is on (`PAP_METRICS_TOKEN` is set). Never the token. */
  metrics: z.boolean(),
  /** The host (and port) the OTLP export goes to, or null when it is off. Never a header (M10R121). */
  otlpHost: z.string().min(1).max(260).nullable(),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

/** The most limited sessions the `usage` snapshot lists (M10R107). */
export const USAGE_MAX_LIMITS = 200;

const Id = z.string().min(1).max(128);

/** A session whose latest run hit the provider's quota, and what happens next (M10R107). */
export const LimitView = z
  .object({
    sessionId: Id,
    runId: Id,
    /** When the quota lifts, if the provider said; null: the chip offers Resume now only. */
    resetAt: z.number().int().min(0).nullable(),
    resume: z.enum(["scheduled", "cancelled", "none"]),
    provider: z.string().max(64).nullable(),
    model: z.string().max(128).nullable(),
  })
  .strict();
export type LimitView = z.infer<typeof LimitView>;

const TodayUsd = z.number().min(0);
const BudgetUsd = z.number().min(0).nullable();

/** The `usage` stream (M10R107): the owner's own; the session snapshot carries none of it. */
export const UsageStreamEvent = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("snapshot"),
      limits: z.array(LimitView).max(USAGE_MAX_LIMITS),
      todayUsd: TodayUsd,
      budgetUsd: BudgetUsd,
      autoResume: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("limit"), limit: LimitView }).strict(),
  z.object({ kind: z.literal("limit_cleared"), sessionId: Id }).strict(),
  z.object({ kind: z.literal("spend"), todayUsd: TodayUsd, budgetUsd: BudgetUsd }).strict(),
]);
export type UsageStreamEvent = z.infer<typeof UsageStreamEvent>;

const SessionParams = z.object({ sessionId: Id }).strict();
const Done = z.object({ ok: z.literal(true) });

export const usageMethods = {
  "usage.summary": defineMethod({
    name: "usage.summary",
    permission: "usage:read",
    idempotent: true,
    params: z.object({ range: UsageRange }).strict(),
    result: UsageSummary,
    errors: [],
  }),
  "subscribe.usage": defineMethod({
    name: "subscribe.usage",
    permission: "usage:read",
    idempotent: true,
    // No key: the stream is the caller's own, like `shell`.
    params: z.object({ after: Cursor.optional() }).strict(),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
  "usage.resumeNow": defineMethod({
    name: "usage.resumeNow",
    permission: "usage:operate",
    idempotent: false,
    params: SessionParams,
    result: Done,
    // conflict: the session's latest run is not limited, is archived, or a resume is already on its way.
    // budget_reached: a token past the daily budget (a browser session is the owner and ignores it).
    // automation_paused: a token while the owner's automation is paused.
    errors: ["not_found", "conflict", "budget_reached", "automation_paused", "capacity", "session_busy"],
  }),
  "usage.cancelResume": defineMethod({
    name: "usage.cancelResume",
    permission: "usage:operate",
    idempotent: false,
    params: SessionParams,
    result: Done,
    errors: ["not_found"],
  }),
} as const;
