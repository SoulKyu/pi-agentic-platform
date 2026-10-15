import { useEffect, useMemo } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedTasks } from "../../stores/tasks-feed.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";

/** Keeps the stream open while `active`: the palette and the Tasks and Trigger panes ask, the page load never does (RT-31). */
export function useTasksFeed(active: boolean): void {
  useEffect(
    () =>
      active
        ? feedTasks(getRuntime().subscriptions, () => reportClientIssue("tasks_feed_failed"))
        : undefined,
    [active],
  );
}

/** Trigger id → name, for titles. Stable until the triggers change. */
export function useTriggerNames(): ReadonlyMap<string, string> {
  const triggers = useTasksStore((state) => state.view.triggers);
  return useMemo(() => new Map(triggers.map((trigger) => [trigger.id, trigger.name])), [triggers]);
}
