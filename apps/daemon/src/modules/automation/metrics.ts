import type { AutomationSettings } from "@pap/contracts";
import type { Db } from "../../kernel/db/database.ts";
import type { MetricsRegistry, Sample } from "../../kernel/observability/prometheus.ts";
import type { RunsService } from "../runs/index.ts";
import { fireSamples } from "./fire-counts.ts";

// The closed sets of the `tasks` and `outbox` CHECK constraints: a state or status the table cannot hold is never a label.
const TASK_STATES = ["queued", "running", "limited", "done", "failed", "cancelled", "interrupted"] as const;
const EFFECT_STATUSES = ["pending", "leased", "done", "failed", "retired"] as const;

interface Settings {
  automation(ownerId: string): Pick<AutomationSettings, "paused" | "dailyBudgetUsd" | "timezone">;
}

function counted(
  db: Db,
  table: "tasks" | "outbox",
  column: string,
  names: readonly string[],
  label: string,
): Sample[] {
  const rows = db.all<{ name: string; n: number }>(
    `SELECT ${column} AS name, COUNT(*) AS n FROM ${table} GROUP BY ${column}`,
  );
  return names.map((name) => ({
    labels: { [label]: name },
    value: rows.find((row) => row.name === name)?.n ?? 0,
  }));
}

/**
 * The automation families (M10R96): tasks by state, outbox effects by status, and the budget. The budget gauges add
 * up the owners who have a trigger or a task: a label would name one. The fire counter
 * is in process (`fire-counts.ts`), one count per journal event.
 */
export function automationCollector(
  db: Db,
  runs: Pick<RunsService["port"], "spentToday">,
  settings: Settings,
): (registry: MetricsRegistry) => void {
  const owners = (): string[] =>
    db
      .all<{ owner_id: string }>("SELECT owner_id FROM tasks UNION SELECT owner_id FROM triggers")
      .map((row) => row.owner_id);
  return (registry) => {
    registry.counter(
      "pap_trigger_fires_total",
      "Fire journal events by trigger source and verdict, since the daemon started.",
      ["source", "verdict"],
      () => fireSamples(db),
    );
    registry.gauge("pap_tasks", "Automation tasks by state.", ["state"], () =>
      counted(db, "tasks", "state", TASK_STATES, "state"),
    );
    registry.gauge("pap_outbox_effects", "Outbox effects by status.", ["status"], () =>
      counted(db, "outbox", "status", EFFECT_STATUSES, "status"),
    );
    registry.gauge("pap_automation_paused", "1 when any owner has paused automation.", [], () => [
      { value: owners().some((owner) => settings.automation(owner).paused) ? 1 : 0 },
    ]);
    registry.gauge(
      "pap_budget_spent_usd_today",
      "Automatic runs' cost today in US dollars, runs in flight included.",
      [],
      () => [
        {
          value: owners().reduce(
            (sum, owner) => sum + runs.spentToday(owner, settings.automation(owner).timezone),
            0,
          ),
        },
      ],
    );
    registry.gauge(
      "pap_budget_usd",
      "The daily automation budget in US dollars; absent without one.",
      [],
      () => {
        const budgets = owners()
          .map((owner) => settings.automation(owner).dailyBudgetUsd)
          .filter((budget): budget is number => budget !== null);
        return budgets.length === 0 ? [] : [{ value: budgets.reduce((a, b) => a + b, 0) }];
      },
    );
  };
}
