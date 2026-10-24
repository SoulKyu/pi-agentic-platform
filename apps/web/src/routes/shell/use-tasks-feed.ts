import { useEffect, useMemo } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { feedTasks } from "../../stores/tasks-feed.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";

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
 * Trigger id → name, `agent:<id>` → name and `terminal:<id>` → project name (a box terminal), for titles. The agents,
 * terminals and projects are read as strings, which compare by value: an unread tick or a state change does not render
 * the tab bar again.
 */
export function useTriggerNames(): ReadonlyMap<string, string> {
  const triggers = useTasksStore((state) => state.view.triggers);
  // Keep the JSON string. The store's default comparison is Object.is: a string compares by value, so an unread tick or
  // a state change leaves it equal and nothing renders. A mapped array would be a new reference on every store change
  // (a render of every tab bar each time), and an equality helper (`useShallow`) would add code to the shell bundle.
  const agents = useAgents((view) => JSON.stringify(view.agents.map((agent) => [agent.id, agent.name])));
  const terminals = useTerminalStore((state) =>
    state.view.list
      .filter((terminal) => terminal.projectId !== null)
      .map((terminal) => JSON.stringify([terminal.id, terminal.projectId]))
      .join("\n"),
  );
  const projects = useShellStore((state) =>
    [...state.view.projects.values()]
      .filter((project) => project.kind === "box")
      .map((project) => JSON.stringify([project.id, project.name]))
      .join("\n"),
  );
  return useMemo(
    () =>
      new Map([
        ...triggers.map((trigger): [string, string] => [trigger.id, trigger.name]),
        ...(JSON.parse(agents) as Array<[string, string]>).map(([id, name]): [string, string] => [
          `agent:${id}`,
          name,
        ]),
        ...boxTerminalNames(terminals, projects),
      ]),
    [triggers, agents, terminals, projects],
  );
}

const rowsOf = (joined: string): string[][] =>
  joined === "" ? [] : joined.split("\n").map((line) => JSON.parse(line) as string[]);

/** `terminal:<id>` → the name of the box project the terminal runs in. */
function boxTerminalNames(terminals: string, projects: string): Array<[string, string]> {
  const names = new Map(rowsOf(projects).map(([id = "", name = ""]) => [id, name]));
  return rowsOf(terminals).flatMap(([id = "", projectId = ""]): Array<[string, string]> => {
    const name = names.get(projectId);
    return name === undefined ? [] : [[`terminal:${id}`, name]];
  });
}
