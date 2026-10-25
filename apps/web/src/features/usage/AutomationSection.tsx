import "./register-automation-settings-catalog.ts";
import type { UsageRange } from "@pap/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedTasks } from "../../stores/tasks-feed.ts";
import { feedUsage } from "../../stores/usage-feed.ts";
import { useUsageStore } from "../../stores/usage-store.ts";
import { AutomationForm } from "./AutomationForm.tsx";
import { ObservabilityState } from "./ObservabilityState.tsx";
import { SpendingPanel } from "./SpendingPanel.tsx";
import { useUsageSummary } from "./use-usage-summary.ts";

/**
 * Settings › Automation (M10R121): this account's automation settings, what it spent, and the state of the exports.
 * It keeps the `tasks` and `usage` streams open while shown, so the pause switch and today's spend follow the board.
 */
export function AutomationSection({ modelsLink }: { readonly modelsLink: (label: string) => ReactNode }) {
  const t = useT();
  const [range, setRange] = useState<UsageRange>("today");
  const { summary, failed } = useUsageSummary(range);
  const usage = useUsageStore((state) => state.view);
  useEffect(() => {
    const { subscriptions } = getRuntime();
    const stopTasks = feedTasks(subscriptions, () => reportClientIssue("tasks_feed_failed"));
    const stopUsage = feedUsage(subscriptions);
    return () => {
      stopTasks();
      stopUsage();
    };
  }, []);

  return (
    <div data-automation-section className="flex flex-col gap-s5">
      <AutomationForm serverZone={summary?.timeZone ?? null} />
      <section className="flex flex-col gap-s3" aria-labelledby="settings-automation-spending">
        <h2 id="settings-automation-spending" className="text-h2 text-fg">
          {t("settingsAutomation.spending.title")}
        </h2>
        <SpendingPanel
          summary={summary}
          failed={failed}
          range={range}
          onRange={setRange}
          spend={usage.loaded ? { todayUsd: usage.todayUsd, budgetUsd: usage.budgetUsd } : null}
          quotasLink={modelsLink(t("settingsAutomation.spending.quotasLink"))}
        />
      </section>
      <section className="flex flex-col gap-s3" aria-labelledby="settings-automation-observability">
        <h2 id="settings-automation-observability" className="text-h2 text-fg">
          {t("settingsAutomation.observability.title")}
        </h2>
        {summary === null ? null : (
          <ObservabilityState metrics={summary.metrics} otlpHost={summary.otlpHost} />
        )}
      </section>
    </div>
  );
}
