import {
  USAGE_BUCKETS_MAX,
  USAGE_METRICS_MAX,
  USAGE_TEXT_MAX,
  type ProviderUsageId,
  type UsageBucket,
  type UsageMetric,
} from "@pap/contracts/pi-host";

/** A provider's answer that holds nothing pap can show: the operation reports it as a failed query. */
export class UnusableAnswer extends Error {}
const unusable = (): never => {
  throw new UnusableAnswer();
};

export const PROVIDER_NAMES: Readonly<Record<ProviderUsageId, string>> = {
  "openai-codex": "OpenAI Codex",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI CN",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
  "kimi-coding": "Kimi For Coding",
};
const CURRENCY = { moonshotai: "USD", "moonshotai-cn": "CNY", minimax: "USD", "minimax-cn": "CNY" } as const;

type Rec = Record<string, unknown>;
export interface Normalized {
  readonly buckets: UsageBucket[];
  readonly metrics: UsageMetric[];
}

const record = (value: unknown): Rec | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;

/** Text from a provider: no control, bidi or zero-width character (they are escapes, never literal), clipped. */
const HIDDEN = [
  [0x00, 0x1f],
  [0x7f, 0xa0],
  [0xad, 0xad],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
] as const;
const visible = (code: number): boolean => !HIDDEN.some(([from, to]) => code >= from && code <= to);
export function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = [...value]
    .filter((char) => visible(char.codePointAt(0) ?? 0))
    .join("")
    .trim();
  return text === "" ? undefined : [...text].slice(0, USAGE_TEXT_MAX).join("");
}

/** A finite number, or a numeric string. */
function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}
const nonneg = (value: unknown): number | undefined => {
  const result = num(value);
  return result !== undefined && result >= 0 ? result : undefined;
};
const count = (value: unknown): number | undefined => {
  const result = nonneg(value);
  return result !== undefined && Number.isSafeInteger(result) ? result : undefined;
};
/** An amount kept as the provider wrote it, so that no float error reaches a balance. */
function decimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && value.length <= 64
    ? value
    : undefined;
}
const percent = (value: number): number => Math.min(100, Math.max(0, value));
function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.floor(value >= 1e12 ? value / 1000 : value);
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed / 1000) : undefined;
}
function windowLabel(seconds: number | undefined): string {
  if (seconds === undefined || seconds <= 0) return "Limit";
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 10_080) return "Weekly";
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
}
const labelled = (group: string | undefined, label: string): string =>
  clean(group === undefined ? label : `${group} · ${label}`) ?? label;
const money = (id: string, label: string, value: string, currency: string): UsageMetric => ({
  id,
  label,
  value,
  unit: "currency",
  currency,
});
const done = (buckets: UsageBucket[], metrics: UsageMetric[]): Normalized => {
  if (buckets.length === 0 && metrics.length === 0) unusable();
  return { buckets: buckets.slice(0, USAGE_BUCKETS_MAX), metrics: metrics.slice(0, USAGE_METRICS_MAX) };
};

function percentBucket(id: string, label: string, used: number, extra: Partial<UsageBucket>): UsageBucket {
  const clamped = percent(used);
  return { id, label, used: clamped, remaining: 100 - clamped, limit: 100, unit: "percent", ...extra };
}

function codex(payload: Rec): Normalized {
  const buckets: UsageBucket[] = [];
  const addGroup = (group: Rec, groupId: string, groupLabel: string | undefined) => {
    for (const position of ["primary", "secondary"] as const) {
      const window = record(group[`${position}_window`]);
      const used = num(window?.used_percent);
      if (used === undefined) continue;
      const seconds = num(window?.limit_window_seconds);
      const resetsAt = epochSeconds(window?.reset_at);
      buckets.push(
        percentBucket(
          clean(`${groupId}:${position}`) ?? position,
          labelled(groupLabel, windowLabel(seconds)),
          used,
          {
            ...(seconds !== undefined && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
            ...(resetsAt === undefined ? {} : { resetsAt }),
          },
        ),
      );
    }
  };
  const main = record(payload.rate_limit);
  if (main) addGroup(main, "codex", undefined);
  const more = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  more.slice(0, USAGE_BUCKETS_MAX).forEach((item, index) => {
    const entry = record(item);
    const rate = record(entry?.rate_limit);
    if (rate)
      addGroup(
        rate,
        clean(entry?.metered_feature) ?? `additional-${index}`,
        clean(entry?.limit_name) ?? `Limit ${index + 1}`,
      );
  });
  const metrics: UsageMetric[] = [];
  const credits = record(payload.credits);
  if (credits?.unlimited === true) metrics.push({ id: "credits", label: "Credits", value: "Unlimited" });
  else if (num(credits?.balance) !== undefined && (num(credits?.balance) ?? -1) >= 0)
    metrics.push({ id: "credits", label: "Credits", value: num(credits?.balance) ?? 0, unit: "count" });
  return done(buckets, metrics);
}

function deepseek(payload: Rec): Normalized {
  const rows = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
  if (rows.length === 0) unusable();
  const metrics: UsageMetric[] = [
    {
      id: "availability",
      label: "API calls",
      value: payload.is_available === true ? "Available" : "Unavailable",
    },
  ];
  const fields = [
    ["total", "Total balance", "total_balance"],
    ["granted", "Granted balance", "granted_balance"],
    ["topped-up", "Topped-up balance", "topped_up_balance"],
  ] as const;
  for (const row of rows.slice(0, 4)) {
    const entry = record(row);
    const currency = entry?.currency === "CNY" || entry?.currency === "USD" ? entry.currency : undefined;
    if (currency === undefined) continue;
    for (const [id, label, field] of fields) {
      const amount = decimal(entry?.[field]);
      if (amount !== undefined)
        metrics.push(money(`${currency.toLowerCase()}-${id}`, label, amount, currency));
    }
  }
  return done([], metrics);
}

function openrouter(payload: Rec): Normalized {
  const data = record(payload.data) ?? unusable();
  const buckets: UsageBucket[] = [];
  const limit = nonneg(data.limit);
  const remaining = nonneg(data.limit_remaining);
  const reset = clean(data.limit_reset);
  if (limit !== undefined)
    buckets.push({
      id: "key-limit",
      label: "Key limit",
      limit,
      ...(remaining === undefined ? {} : { remaining, used: Math.max(0, limit - remaining) }),
      unit: "currency",
      currency: "USD",
      ...(reset === undefined ? {} : { period: reset }),
    });
  const metrics: UsageMetric[] = [];
  for (const [id, label, field] of [
    ["daily", "Usage today", "usage_daily"],
    ["weekly", "Usage this week", "usage_weekly"],
    ["monthly", "Usage this month", "usage_monthly"],
    ["total", "All-time usage", "usage"],
  ] as const) {
    const amount = nonneg(data[field]);
    if (amount !== undefined) metrics.push({ id, label, value: amount, unit: "currency", currency: "USD" });
  }
  return done(buckets, metrics);
}

function vercel(payload: Rec): Normalized {
  const balance = decimal(payload.balance);
  const spent = decimal(payload.total_used);
  return done(
    [],
    [
      ...(balance === undefined ? [] : [money("balance", "Credit balance", balance, "USD")]),
      ...(spent === undefined ? [] : [money("spent", "Lifetime spend", spent, "USD")]),
    ],
  );
}

function moonshot(id: "moonshotai" | "moonshotai-cn", payload: Rec): Normalized {
  const data = record(payload.data);
  if (payload.code !== 0 || payload.status !== true || !data) unusable();
  const metrics: UsageMetric[] = [];
  for (const [key, label, field] of [
    ["available", "Available balance", "available_balance"],
    ["voucher", "Voucher balance", "voucher_balance"],
    ["cash", "Cash balance", "cash_balance"],
  ] as const) {
    const amount = num(data?.[field]);
    if (amount !== undefined) metrics.push(money(key, label, String(amount), CURRENCY[id]));
  }
  return done([], metrics);
}

/** One MiniMax window: counts when it gives them, else the percent left. The count's meaning is read from the percent. */
function minimaxWindow(row: Rec, model: string, kind: "interval" | "weekly"): UsageBucket | undefined {
  const prefix = kind === "interval" ? "current_interval" : "current_weekly";
  const [startKey, endKey] =
    kind === "interval" ? ["start_time", "end_time"] : ["weekly_start_time", "weekly_end_time"];
  const id = clean(`${model}:${kind}`) ?? kind;
  const label = labelled(model, kind === "weekly" ? "Weekly" : "Rolling");
  if (num(row[`${prefix}_status`]) === 3)
    return { id, label, remaining: 100, unit: "percent", period: "Unlimited" };
  const total = count(row[`${prefix}_total_count`]);
  const seen = count(row[`${prefix}_usage_count`]);
  const left = nonneg(row[`${prefix}_remaining_percent`]);
  const start = num(row[startKey]);
  const end = num(row[endKey]);
  const windowMinutes =
    start !== undefined && end !== undefined && end > start
      ? Math.max(1, Math.round((end - start) / 60_000))
      : undefined;
  const resetsAt = end === undefined ? undefined : epochSeconds(end);
  const timing = {
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
  if (total !== undefined && total > 0 && seen !== undefined && seen <= total) {
    let remaining = seen;
    if (
      left !== undefined &&
      Math.abs(((total - seen) / total) * 100 - left) < Math.abs((seen / total) * 100 - left)
    )
      remaining = total - seen;
    return { id, label, used: total - remaining, remaining, limit: total, unit: "count", ...timing };
  }
  return left === undefined ? undefined : percentBucket(id, label, 100 - percent(left), timing);
}

function minimax(id: "minimax" | "minimax-cn", payload: Rec): Normalized {
  const base = record(payload.base_resp);
  if (base && base.status_code !== 0) unusable();
  if (Array.isArray(payload.model_remains)) {
    const buckets: UsageBucket[] = [];
    payload.model_remains.slice(0, USAGE_BUCKETS_MAX).forEach((value, index) => {
      const row = record(value);
      if (!row) return;
      const model = clean(row.model_name) ?? `Quota ${index + 1}`;
      for (const kind of ["interval", "weekly"] as const) {
        const bucket = minimaxWindow(row, model, kind);
        if (bucket) buckets.push(bucket);
      }
    });
    return done(buckets, []);
  }
  const metrics: UsageMetric[] = [];
  for (const [key, label, field] of [
    ["available", "Available balance", "available_amount"],
    ["cash", "Cash balance", "cash_balance"],
    ["voucher", "Voucher balance", "voucher_balance"],
    ["credit", "Credit balance", "credit_balance"],
  ] as const) {
    const amount = decimal(payload[field]);
    if (amount !== undefined) metrics.push(money(key, label, amount, CURRENCY[id]));
  }
  return done([], metrics);
}

function opencodeGo(payload: Rec): Normalized {
  const windows = record(payload.usage) ?? payload;
  const names: Record<string, string> = { rolling: "Rolling", weekly: "Weekly", monthly: "Monthly" };
  const buckets: UsageBucket[] = [];
  for (const [key, raw] of Object.entries(windows)) {
    const window = record(raw);
    const used = nonneg(window?.percent ?? window?.usagePercent ?? window?.usage_percent);
    const id = clean(key);
    if (used === undefined || id === undefined) continue;
    const resetsAt = epochSeconds(
      window?.resetsAt ?? window?.resetAt ?? window?.resets_at ?? window?.reset_at,
    );
    buckets.push(percentBucket(id, names[key] ?? id, used, resetsAt === undefined ? {} : { resetsAt }));
    if (buckets.length === USAGE_BUCKETS_MAX) break;
  }
  return done(buckets, []);
}

const KIMI_UNIT_SECONDS: Readonly<Record<string, number>> = {
  TIME_UNIT_SECOND: 1,
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: 3600,
  TIME_UNIT_DAY: 86_400,
};

function kimi(payload: Rec): Normalized {
  const buckets: UsageBucket[] = [];
  const add = (id: string, label: string, detail: Rec | undefined, seconds?: number) => {
    const limit = count(detail?.limit);
    const used = count(detail?.used);
    const remaining =
      count(detail?.remaining) ??
      (limit !== undefined && used !== undefined ? Math.max(0, limit - used) : undefined);
    if (limit === undefined || remaining === undefined) return;
    const resetsAt = epochSeconds(detail?.resetTime);
    buckets.push({
      id,
      label,
      used: used ?? Math.max(0, limit - remaining),
      remaining,
      limit,
      unit: "count",
      ...(seconds === undefined || seconds <= 0 ? {} : { windowMinutes: Math.ceil(seconds / 60) }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  };
  add("usage", "Overall", record(payload.usage));
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  limits.slice(0, USAGE_BUCKETS_MAX - 1).forEach((item, index) => {
    const entry = record(item);
    const window = record(entry?.window);
    const duration = nonneg(window?.duration);
    const unit = KIMI_UNIT_SECONDS[clean(window?.timeUnit) ?? ""];
    const seconds = duration !== undefined && unit !== undefined ? duration * unit : undefined;
    add(`limit-${index}`, windowLabel(seconds), record(entry?.detail), seconds);
  });
  const metrics: UsageMetric[] = [];
  const parallel = count(record(payload.parallel)?.limit);
  if (parallel !== undefined)
    metrics.push({ id: "parallel", label: "Parallel requests", value: parallel, unit: "count" });
  const level = clean(record(record(payload.user)?.membership)?.level);
  if (level !== undefined)
    metrics.push({ id: "membership", label: "Membership", value: level.replace(/^LEVEL_/u, "") });
  return done(buckets, metrics);
}

/** A provider's JSON object as buckets and metrics; throws `UnusableAnswer` when nothing in it can be shown. */
export function normalizeUsage(id: ProviderUsageId, payload: Rec): Normalized {
  switch (id) {
    case "openai-codex":
      return codex(payload);
    case "deepseek":
      return deepseek(payload);
    case "openrouter":
      return openrouter(payload);
    case "vercel-ai-gateway":
      return vercel(payload);
    case "moonshotai":
    case "moonshotai-cn":
      return moonshot(id, payload);
    case "minimax":
    case "minimax-cn":
      return minimax(id, payload);
    case "opencode-go":
      return opencodeGo(payload);
    case "kimi-coding":
      return kimi(payload);
  }
}
