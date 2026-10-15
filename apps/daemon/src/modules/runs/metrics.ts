import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MetricsRegistry, Sample } from "../../kernel/observability/prometheus.ts";
import { scrubKnownSecrets } from "../audit/index.ts";
import { labelValue } from "./labels.ts";
import { topLabels } from "./metrics-auth.ts";

/** The families read the table at most this often (M10R96). */
export const SCRAPE_CACHE_MS = 15_000;
/** At most this many distinct `model` values; the rest read `other` (M10R97). */
export const MAX_MODEL_LABELS = 100;

// A run's origin is free text of at most 32 characters in the table; a label takes only these (M10R97).
const ORIGINS: ReadonlySet<string> = new Set([
  "user",
  "extension",
  "trigger",
  "manual",
  "retry",
  "resume",
  "schedule",
  "webhook",
  "feed",
  "delegate",
  "remind",
]);
const TOKEN_KINDS = ["input", "output", "cache_read", "cache_write"] as const;

interface ByStatus {
  origin: string;
  status: string;
  runs: number;
  ms: number;
}
interface ByModel {
  provider: string | null;
  model: string | null;
  billing: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface Loaded {
  readonly runs: Sample[];
  readonly durationSum: Sample[];
  readonly durationCount: Sample[];
  readonly tokens: Sample[];
  readonly cost: Sample[];
}

const originOf = (origin: string): string => (ORIGINS.has(origin) ? origin : "other");
const byLabels = (a: Sample, b: Sample): number => {
  const key = (sample: Sample) => Object.values(sample.labels ?? {}).join("\u0000");
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
};

function sumInto(table: Map<string, Sample>, labels: Record<string, string>, value: number): void {
  const key = JSON.stringify(labels);
  const held = table.get(key);
  table.set(key, { labels, value: (held?.value ?? 0) + value });
}
const sorted = (table: Map<string, Sample>): Sample[] => [...table.values()].sort(byLabels);

function load(db: Db): Loaded {
  // Only finished runs: a counter must never go down when a run in flight ends.
  const statuses = db.all<ByStatus>(
    "SELECT origin, status, COUNT(*) AS runs, SUM(ended_at - started_at) AS ms FROM runs " +
      "WHERE status <> 'running' GROUP BY origin, status",
  );
  const models = db.all<ByModel>(
    "SELECT provider, model, billing, SUM(input_tokens) AS input, SUM(output_tokens) AS output, " +
      "SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite, SUM(cost_usd) AS cost " +
      "FROM runs WHERE status <> 'running' GROUP BY provider, model, billing",
  );

  const runs = new Map<string, Sample>();
  const durationSum = new Map<string, Sample>();
  const durationCount = new Map<string, Sample>();
  for (const row of statuses) {
    const origin = originOf(row.origin);
    sumInto(runs, { origin, status: row.status }, row.runs);
    sumInto(durationSum, { origin }, row.ms / 1000);
    sumInto(durationCount, { origin }, row.runs);
  }

  const weights = new Map<string, number>();
  for (const row of models) {
    const model = labelValue(row.model, scrubKnownSecrets);
    weights.set(model, (weights.get(model) ?? 0) + row.cost);
  }
  const keep = topLabels(weights, MAX_MODEL_LABELS);
  const tokens = new Map<string, Sample>();
  const cost = new Map<string, Sample>();
  for (const row of models) {
    const provider = labelValue(row.provider, scrubKnownSecrets);
    const model = keep(labelValue(row.model, scrubKnownSecrets));
    const counts = [row.input, row.output, row.cacheRead, row.cacheWrite];
    TOKEN_KINDS.forEach((kind, index) => sumInto(tokens, { kind, provider, model }, counts[index] ?? 0));
    sumInto(cost, { provider, model, billing: row.billing }, row.cost);
  }
  return {
    runs: sorted(runs),
    durationSum: sorted(durationSum),
    durationCount: sorted(durationCount),
    tokens: sorted(tokens),
    cost: sorted(cost),
  };
}

/**
 * The families built from the `runs` table, so they survive restarts and never go backwards (M10R96). Labels come from
 * closed sets, or through `labelValue` and `topLabels` (M10R97); never a session, task, owner, path or text.
 */
export function registerRunsMetrics(
  registry: MetricsRegistry,
  deps: { readonly db: Db; readonly clock: Clock },
): void {
  let cached: { at: number; loaded: Loaded } | null = null;
  const loaded = (): Loaded => {
    const now = deps.clock.now();
    if (cached === null || now - cached.at >= SCRAPE_CACHE_MS || now < cached.at)
      cached = { at: now, loaded: load(deps.db) };
    return cached.loaded;
  };
  registry.counter(
    "pap_runs_total",
    "Finished runs by origin and status.",
    ["origin", "status"],
    () => loaded().runs,
  );
  registry.counter(
    "pap_run_tokens_total",
    "Tokens of finished runs by kind, provider and model.",
    ["kind", "provider", "model"],
    () => loaded().tokens,
  );
  registry.counter(
    "pap_run_cost_usd_total",
    "Cost in US dollars of finished runs by provider, model and billing.",
    ["provider", "model", "billing"],
    () => loaded().cost,
  );
  registry.counter(
    "pap_run_duration_seconds_sum",
    "Seconds finished runs lasted, by origin.",
    ["origin"],
    () => loaded().durationSum,
  );
  registry.counter(
    "pap_run_duration_seconds_count",
    "Finished runs that have a duration, by origin.",
    ["origin"],
    () => loaded().durationCount,
  );
}
