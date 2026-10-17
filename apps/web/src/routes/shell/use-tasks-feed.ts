import { useEffect, useMemo } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useAgents } from "../../stores/agents-store.ts";
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

/**
 * Trigger id → name and `agent:<id>` → name, for titles. The agents are read as one string of ids and names, which
 * compares by value: an unread tick or a state change of an agent does not render the tab bar again.
 */
export function useTriggerNames(): ReadonlyMap<string, string> {
  const triggers = useTasksStore((state) => state.view.triggers);
  // Keep the JSON string. The store's default comparison is Object.is: a string compares by value, so an unread tick or
  // a state change leaves it equal and nothing renders. A mapped array would be a new reference on every store change
  // (a render of every tab bar each time), and an equality helper (`useShallow`) would add code to the shell bundle.
  const agents = useAgents((view) => JSON.stringify(view.agents.map((agent) => [agent.id, agent.name])));
  return useMemo(
    () =>
      new Map([
        ...triggers.map((trigger): [string, string] => [trigger.id, trigger.name]),
        ...(JSON.parse(agents) as Array<[string, string]>).map(([id, name]): [string, string] => [
          `agent:${id}`,
          name,
        ]),
      ]),
    [triggers, agents],
  );
}
