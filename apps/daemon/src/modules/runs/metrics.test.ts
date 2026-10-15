import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMetricsRegistry, type MetricsRegistry } from "../../kernel/observability/prometheus.ts";
import { registerRunsMetrics, SCRAPE_CACHE_MS } from "./metrics.ts";
import { createRunsStore, type RunsStore } from "./store.ts";
import { openRunsBed, type RunsBed } from "./testing/bed.ts";

let bed: RunsBed;
let store: RunsStore;
let registry: MetricsRegistry;
beforeEach(() => {
  bed = openRunsBed();
  store = createRunsStore(bed.db);
  registry = createMetricsRegistry({ clock: bed.clock, logger: bed.logger });
  registerRunsMetrics(registry, { db: bed.db, clock: bed.clock });
});
afterEach(() => bed.close());

let counter = 0;
function add(
  fields: {
    origin?: string;
    status?: "completed" | "failed";
    provider?: string | null;
    model?: string | null;
    billing?: "api" | "subscription" | "unknown";
    cost?: number;
    tokens?: [number, number, number, number];
    startedAt?: number;
    endedAt?: number;
    running?: boolean;
  } = {},
) {
  const id = `r${++counter}`;
  const startedAt = fields.startedAt ?? 1000;
  store.insertRunning({
    id,
    ownerId: "u1",
    sessionId: "s-secret-session",
    taskId: null,
    origin: fields.origin ?? "user",
    startedAt,
  });
  const [input, output, cacheRead, cacheWrite] = fields.tokens ?? [1, 2, 3, 4];
  const progress = {
    provider: fields.provider === undefined ? "anthropic" : fields.provider,
    model: fields.model === undefined ? "claude-sonnet" : fields.model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUsd: fields.cost ?? 0.5,
    turns: 1,
    toolCalls: 0,
  };
  if (fields.running) return store.saveProgress(id, progress);
  store.finish(id, {
    ...progress,
    status: fields.status ?? "completed",
    endedAt: fields.endedAt ?? startedAt + 2000,
    billing: fields.billing ?? "api",
    errorClass: null,
    limitResetAt: null,
  });
}

const lines = async (name: string): Promise<string[]> =>
  (await registry.collect())
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `));

describe("the families built from the runs table", () => {
  it("counts the finished runs by origin and status (a run in flight is not a counter yet), tokens by kind, cost, and duration", async () => {
    add({ origin: "user", cost: 0.5, tokens: [1, 2, 3, 4] });
    add({ origin: "user", cost: 0.25, tokens: [10, 20, 30, 40], endedAt: 5000 });
    add({ origin: "trigger", status: "failed", billing: "subscription", cost: 1 });
    add({ origin: "user", running: true });
    expect(await lines("pap_runs_total")).toEqual([
      'pap_runs_total{origin="trigger",status="failed"} 1',
      'pap_runs_total{origin="user",status="completed"} 2',
    ]);
    expect(await lines("pap_run_tokens_total")).toContain(
      'pap_run_tokens_total{kind="input",provider="anthropic",model="claude-sonnet"} 12',
    );
    expect(await lines("pap_run_tokens_total")).toContain(
      'pap_run_tokens_total{kind="cache_write",provider="anthropic",model="claude-sonnet"} 48',
    );
    expect(await lines("pap_run_cost_usd_total")).toEqual([
      'pap_run_cost_usd_total{provider="anthropic",model="claude-sonnet",billing="api"} 0.75',
      'pap_run_cost_usd_total{provider="anthropic",model="claude-sonnet",billing="subscription"} 1',
    ]);
    expect(await lines("pap_run_duration_seconds_sum")).toEqual([
      'pap_run_duration_seconds_sum{origin="trigger"} 2',
      'pap_run_duration_seconds_sum{origin="user"} 6',
    ]);
    expect(await lines("pap_run_duration_seconds_count")).toEqual([
      'pap_run_duration_seconds_count{origin="trigger"} 1',
      'pap_run_duration_seconds_count{origin="user"} 2',
    ]);
  });

  it("reads an origin outside the closed set as other", async () => {
    add({ origin: 'evil"} x 1' });
    expect(await lines("pap_runs_total")).toEqual(['pap_runs_total{origin="other",status="completed"} 1']);
  });

  it("serves the same numbers for 15 s, then reads the table again", async () => {
    add({ cost: 1 });
    const first = await registry.collect();
    add({ cost: 1 });
    await bed.clock.advance(SCRAPE_CACHE_MS - 1);
    expect(await registry.collect()).toBe(first);
    await bed.clock.advance(1);
    expect(await registry.collect()).not.toBe(first);
  });

  it("never exposes a model id that looks like a secret, a path or a session", async () => {
    add({ model: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", cost: 1 });
    add({ model: "/home/alice/models/qwen.gguf", provider: "~/prov" });
    add({ model: "a/../b" });
    const text = await registry.collect();
    expect(text).toContain('model="other"');
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("/home");
    expect(text).not.toContain("alice");
    expect(text).not.toContain("~");
    expect(text).not.toContain("a/../b");
    expect(text).not.toContain("s-secret-session");
  });

  it("names a run with no provider or model none", async () => {
    add({ provider: null, model: null });
    expect(await lines("pap_run_cost_usd_total")).toEqual([
      'pap_run_cost_usd_total{provider="none",model="none",billing="api"} 0.5',
    ]);
  });

  it("keeps the 100 most expensive models, the same set at two scrapes 15 s apart, and sums the rest as other", async () => {
    for (let index = 0; index < 120; index++) {
      add({ model: `model-${String(index).padStart(3, "0")}`, cost: 1 + index });
    }
    const models = (text: string): Set<string> =>
      new Set(
        [...text.matchAll(/pap_run_cost_usd_total\{provider="anthropic",model="([^"]+)"/g)].map(
          (m) => m[1] ?? "",
        ),
      );
    const first = models(await registry.collect());
    await bed.clock.advance(SCRAPE_CACHE_MS);
    const second = models(await registry.collect());
    expect(first.size).toBe(101);
    expect(first.has("other")).toBe(true);
    expect(first.has("model-119")).toBe(true);
    expect(first.has("model-020")).toBe(true);
    expect(first.has("model-019")).toBe(false);
    expect(second).toEqual(first);
    // 20 cheapest: 1..20
    expect(await lines("pap_run_cost_usd_total")).toContain(
      'pap_run_cost_usd_total{provider="anthropic",model="other",billing="api"} 210',
    );
  });
});
