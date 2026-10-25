import type { ProviderUsageId } from "@pap/contracts/pi-host";

const RESET_ISO = "2027-01-15T08:00:00Z";
export const RESET_SECONDS = Date.parse(RESET_ISO) / 1000;

export interface Recorded {
  /** The base URL the provider is configured with: an official origin. */
  readonly baseUrl: string;
  readonly key: string;
  /** The one address the key may be sent to. */
  readonly url: string;
  readonly payload: unknown;
  readonly buckets: readonly Record<string, unknown>[];
  readonly metrics: readonly Record<string, unknown>[];
}

const money = (id: string, label: string, value: string, currency: string) => ({
  id,
  label,
  value,
  unit: "currency",
  currency,
});

/** Shapes as the providers answer them (field names only; every number is made up). */
export const RECORDED: Readonly<Record<ProviderUsageId, Recorded>> = {
  "openai-codex": {
    baseUrl: "https://chatgpt.com/backend-api",
    key: "sk-codex-secret",
    url: "https://chatgpt.com/backend-api/wham/usage",
    payload: {
      rate_limit: {
        primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 1_800_100_000 },
      },
      additional_rate_limits: [
        {
          limit_name: "Spark",
          metered_feature: "spark",
          rate_limit: {
            primary_window: { used_percent: 5, limit_window_seconds: 3600, reset_at: 1_800_003_600 },
          },
        },
      ],
      credits: { unlimited: false, balance: "3.5" },
    },
    buckets: [
      {
        id: "codex:primary",
        label: "5h",
        used: 12.5,
        remaining: 87.5,
        limit: 100,
        unit: "percent",
        windowMinutes: 300,
        resetsAt: 1_800_000_000,
      },
      {
        id: "codex:secondary",
        label: "Weekly",
        used: 40,
        remaining: 60,
        limit: 100,
        unit: "percent",
        windowMinutes: 10080,
        resetsAt: 1_800_100_000,
      },
      {
        id: "spark:primary",
        label: "Spark · 1h",
        used: 5,
        remaining: 95,
        limit: 100,
        unit: "percent",
        windowMinutes: 60,
        resetsAt: 1_800_003_600,
      },
    ],
    metrics: [{ id: "credits", label: "Credits", value: 3.5, unit: "count" }],
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    key: "sk-deepseek-secret",
    url: "https://api.deepseek.com/user/balance",
    payload: {
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
        { currency: "EUR", total_balance: "1" },
      ],
    },
    buckets: [],
    metrics: [
      { id: "availability", label: "API calls", value: "Available" },
      money("usd-total", "Total balance", "110.00", "USD"),
      money("usd-granted", "Granted balance", "10.00", "USD"),
      money("usd-topped-up", "Topped-up balance", "100.00", "USD"),
    ],
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    key: "sk-or-secret",
    url: "https://openrouter.ai/api/v1/key",
    payload: {
      data: {
        limit: 50,
        limit_remaining: 12.25,
        limit_reset: "monthly",
        usage_daily: 1.5,
        usage_weekly: 7,
        usage_monthly: 37.75,
        usage: 120,
      },
    },
    buckets: [
      {
        id: "key-limit",
        label: "Key limit",
        used: 37.75,
        remaining: 12.25,
        limit: 50,
        unit: "currency",
        currency: "USD",
        period: "monthly",
      },
    ],
    metrics: [
      { id: "daily", label: "Usage today", value: 1.5, unit: "currency", currency: "USD" },
      { id: "weekly", label: "Usage this week", value: 7, unit: "currency", currency: "USD" },
      { id: "monthly", label: "Usage this month", value: 37.75, unit: "currency", currency: "USD" },
      { id: "total", label: "All-time usage", value: 120, unit: "currency", currency: "USD" },
    ],
  },
  moonshotai: {
    baseUrl: "https://api.moonshot.ai/v1",
    key: "sk-moon-secret",
    url: "https://api.moonshot.ai/v1/users/me/balance",
    payload: {
      code: 0,
      status: true,
      data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 },
    },
    buckets: [],
    metrics: [
      money("available", "Available balance", "49.58", "USD"),
      money("voucher", "Voucher balance", "46.58", "USD"),
      money("cash", "Cash balance", "3", "USD"),
    ],
  },
  "moonshotai-cn": {
    baseUrl: "https://api.moonshot.cn/v1",
    key: "sk-moon-cn-secret",
    url: "https://api.moonshot.cn/v1/users/me/balance",
    payload: { code: 0, status: true, data: { available_balance: 8 } },
    buckets: [],
    metrics: [money("available", "Available balance", "8", "CNY")],
  },
  minimax: {
    baseUrl: "https://api.minimax.io/anthropic",
    key: "sk-minimax-secret",
    url: "https://api.minimax.io/v1/token_plan/remains",
    payload: {
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: "MiniMax-M2",
          current_interval_total_count: 1500,
          current_interval_usage_count: 1200,
          current_interval_remaining_percent: 80,
          current_interval_status: 1,
          start_time: 1_800_000_000_000,
          end_time: 1_800_018_000_000,
          current_weekly_status: 3,
        },
      ],
    },
    buckets: [
      {
        id: "MiniMax-M2:interval",
        label: "MiniMax-M2 · Rolling",
        used: 300,
        remaining: 1200,
        limit: 1500,
        unit: "count",
        windowMinutes: 300,
        resetsAt: 1_800_018_000,
      },
      {
        id: "MiniMax-M2:weekly",
        label: "MiniMax-M2 · Weekly",
        remaining: 100,
        unit: "percent",
        period: "Unlimited",
      },
    ],
    metrics: [],
  },
  "minimax-cn": {
    baseUrl: "https://api.minimaxi.com/anthropic",
    key: "sk-api-minimax-cn-secret",
    url: "https://api.minimaxi.com/account/query_balance",
    payload: {
      base_resp: { status_code: 0 },
      available_amount: "12.5",
      cash_balance: "10",
      voucher_balance: "2.5",
    },
    buckets: [],
    metrics: [
      money("available", "Available balance", "12.5", "CNY"),
      money("cash", "Cash balance", "10", "CNY"),
      money("voucher", "Voucher balance", "2.5", "CNY"),
    ],
  },
  "vercel-ai-gateway": {
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    key: "vck-secret",
    url: "https://ai-gateway.vercel.sh/v1/credits",
    payload: { balance: "95.5", total_used: "4.5" },
    buckets: [],
    metrics: [
      money("balance", "Credit balance", "95.5", "USD"),
      money("spent", "Lifetime spend", "4.5", "USD"),
    ],
  },
  "opencode-go": {
    baseUrl: "https://opencode.ai/zen/go/v1",
    key: "oc-secret",
    url: "https://opencode.ai/zen/go/v1/usage",
    payload: {
      usage: {
        rolling: { usagePercent: 30, resetsAt: RESET_ISO },
        weekly: { percent: 55, resetAt: 1_800_000_000_000 },
        note: "not a window",
      },
    },
    buckets: [
      {
        id: "rolling",
        label: "Rolling",
        used: 30,
        remaining: 70,
        limit: 100,
        unit: "percent",
        resetsAt: RESET_SECONDS,
      },
      {
        id: "weekly",
        label: "Weekly",
        used: 55,
        remaining: 45,
        limit: 100,
        unit: "percent",
        resetsAt: 1_800_000_000,
      },
    ],
    metrics: [],
  },
  "kimi-coding": {
    baseUrl: "https://api.kimi.com/coding/v1",
    key: "kimi-secret",
    url: "https://api.kimi.com/coding/v1/usages",
    payload: {
      usage: { limit: "100", used: "40", remaining: "60", resetTime: RESET_ISO },
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "50", used: "10", remaining: "40", resetTime: RESET_ISO },
        },
      ],
      parallel: { limit: "20" },
      user: { membership: { level: "LEVEL_INTERMEDIATE" } },
    },
    buckets: [
      {
        id: "usage",
        label: "Overall",
        used: 40,
        remaining: 60,
        limit: 100,
        unit: "count",
        resetsAt: RESET_SECONDS,
      },
      {
        id: "limit-0",
        label: "5h",
        used: 10,
        remaining: 40,
        limit: 50,
        unit: "count",
        windowMinutes: 300,
        resetsAt: RESET_SECONDS,
      },
    ],
    metrics: [
      { id: "parallel", label: "Parallel requests", value: 20, unit: "count" },
      { id: "membership", label: "Membership", value: "INTERMEDIATE" },
    ],
  },
};
