import type { AgentSummary, TaskTrigger, TaskView } from "@pap/contracts";
import { countRunning } from "./board.vm.ts";

export interface AgentColumn {
  readonly agent: AgentSummary;
  readonly triggers: readonly TaskTrigger[];
  readonly tasks: readonly TaskView[];
  /** Slots in use: the agent's tasks that are running. */
  readonly running: number;
}

/** Needs input first, then running, queued, and the rest; inside a group the newest first (the project columns' order). */
const rank = (task: TaskView): number =>
  task.state === "running" ? (task.needsInput ? 0 : 1) : task.state === "queued" ? 2 : 3;
const byRank = (a: TaskView, b: TaskView) => rank(a) - rank(b) || b.createdAt - a.createdAt;

/** One column per agent, in the agents' order (M11R128), even an agent with nothing yet: its strip starts a trigger. */
export function agentColumns(
  tasks: readonly TaskView[],
  triggers: readonly TaskTrigger[],
  agents: readonly AgentSummary[],
): AgentColumn[] {
  return agents.map((agent) => {
    const own = tasks.filter((task) => task.agentId === agent.id).sort(byRank);
    return {
      agent,
      triggers: triggers.filter((trigger) => trigger.agentId === agent.id),
      tasks: own,
      running: countRunning(own),
    };
  });
}

/** The name on a delegated task's "requested by" line; null for any other task, or when that agent is gone. */
export const requestedByName = (task: TaskView, agents: readonly AgentSummary[]): string | null =>
  agents.find((agent) => agent.id === task.requestedBy)?.name ?? null;
