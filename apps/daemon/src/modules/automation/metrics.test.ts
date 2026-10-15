import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMetricsRegistry, type MetricsRegistry } from "../../kernel/observability/prometheus.ts";
import { openM10Core, type M10TestCore } from "../../testing/m10-core.ts";
import { assistantEnd } from "../runs/testing/events.ts";
import { createRunsModule } from "../runs/index.ts";
import { automationCollector } from "./metrics.ts";

let bed: M10TestCore;
let registry: MetricsRegistry;
let budgets: Record<string, { paused: boolean; dailyBudgetUsd: number | null; timezone: string | null }>;
beforeEach(() => {
  bed = openM10Core();
  const { db, clock, logger } = bed.core;
  const runs = createRunsModule({ db, clock, logger, appendLine: () => {} });
  budgets = { u1: { paused: false, dailyBudgetUsd: 5, timezone: "UTC" } };
  registry = createMetricsRegistry({ clock, logger });
  automationCollector(db, runs.port, { automation: (ownerId) => budgets[ownerId] ?? fallback })(registry);
  runsForTest = runs;
});
afterEach(() => bed.close());

const fallback = { paused: false, dailyBudgetUsd: null, timezone: null };
let runsForTest: ReturnType<typeof createRunsModule>;
let counter = 0;

function task(state: string, ownerId = "u1"): void {
  const ended = ["done", "failed", "cancelled", "interrupted"].includes(state);
  bed.core.db.run(
    "INSERT INTO tasks (id, owner_id, origin, state, cwd, prompt, tainted, policy, title, max_run_ms, created_at, ended_at) " +
      "VALUES ($id, $ownerId, 'manual', $state, '/secret/path', 'secret prompt', 0, '{}', 'secret title', 60000, 1, $endedAt)",
    { id: `t${++counter}`, ownerId, state, endedAt: ended ? 2 : null },
  );
}
function effect(status: string): void {
  const settled = ["done", "failed", "retired"].includes(status);
  bed.core.db.run(
    "INSERT INTO outbox (kind, replay, owner_id, payload, status, next_at, lease_until, created_at, settled_at) " +
      "VALUES ('feed.poll', 'replay-safe', 'u1', '{}', $status, 0, $lease, 1, $settled)",
    { status, lease: status === "leased" ? 9 : null, settled: settled ? 2 : null },
  );
}

const lines = async (name: string): Promise<string[]> =>
  (await registry.collect())
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) || line.startsWith(`${name} `));

describe("the automation families", () => {
  it("counts tasks by state, with every state present", async () => {
    task("queued");
    task("queued");
    task("running");
    task("done");
    expect(await lines("pap_tasks")).toEqual([
      'pap_tasks{state="queued"} 2',
      'pap_tasks{state="running"} 1',
      'pap_tasks{state="limited"} 0',
      'pap_tasks{state="done"} 1',
      'pap_tasks{state="failed"} 0',
      'pap_tasks{state="cancelled"} 0',
      'pap_tasks{state="interrupted"} 0',
    ]);
  });

  it("counts outbox effects by status, with every status present", async () => {
    effect("pending");
    effect("failed");
    effect("failed");
    expect(await lines("pap_outbox_effects")).toEqual([
      'pap_outbox_effects{status="pending"} 1',
      'pap_outbox_effects{status="leased"} 0',
      'pap_outbox_effects{status="done"} 0',
      'pap_outbox_effects{status="failed"} 2',
      'pap_outbox_effects{status="retired"} 0',
    ]);
  });

  it("reports the pause, the budget, and today's spend with a running run's live cost", async () => {
    task("running");
    runsForTest.port.expectOrigin("s1", { origin: "trigger", taskId: "t1" });
    runsForTest.observer.onRecord({ id: "s1", ownerId: "u1" }, "run_start", { origin: "user" }, null);
    runsForTest.observer.onEvent("s1", assistantEnd({ cost: 0.75 }));
    budgets.u1 = { paused: true, dailyBudgetUsd: 5, timezone: "UTC" };
    expect(await lines("pap_automation_paused")).toEqual(["pap_automation_paused 1"]);
    expect(await lines("pap_budget_usd")).toEqual(["pap_budget_usd 5"]);
    expect(await lines("pap_budget_spent_usd_today")).toEqual(["pap_budget_spent_usd_today 0.75"]);
  });

  it("has no budget sample when no owner has a budget", async () => {
    task("queued");
    budgets.u1 = { paused: false, dailyBudgetUsd: null, timezone: null };
    expect(await lines("pap_budget_usd")).toEqual([]);
    expect(await lines("pap_automation_paused")).toEqual(["pap_automation_paused 0"]);
  });

  it("holds nothing of a task or an effect but its state", async () => {
    task("running");
    effect("pending");
    const text = await registry.collect();
    for (const secret of ["secret", "/secret/path", "u1", "feed.poll"]) expect(text).not.toContain(secret);
  });
});
