import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { agentAt, agentTarget, nextUnread } from "../../features/agents/rail.vm.ts";
import { registerCommand } from "../../features/commands/index.ts";
import { activeTab, pathOfItem, useWorkspaceStore } from "../../features/workspace/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { go } from "./tab-actions.ts";

const POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * `agent.goto.1` to `agent.goto.9` (the n-th agent in creation order), `agent.nextUnread` and `agent.prevUnread` (M11R109).
 * A handler that finds nothing to open declines, so the key keeps its browser meaning. The keys' `when` clauses
 * (never in a text field or a dialog, RT-19) live in the defaults, where Settings › Shortcuts can edit them.
 */
export function useAgentCommands(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const agents = () => useAgentsStore.getState().view.agents;
    const open = (agent: ReturnType<typeof agentAt>) => {
      if (agent === null) return false;
      go(navigate, pathOfItem(agentTarget(agent)));
    };
    const activeId = () => {
      const item = activeTab(useWorkspaceStore.getState().ws)?.item;
      return item?.kind === "agent" ? item.id : null;
    };
    const stops = [
      ...POSITIONS.map((n) => registerCommand(`agent.goto.${n}`, () => open(agentAt(agents(), n)))),
      registerCommand("agent.nextUnread", () => open(nextUnread(agents(), activeId(), 1))),
      registerCommand("agent.prevUnread", () => open(nextUnread(agents(), activeId(), -1))),
    ];
    return () => stops.forEach((stop) => stop());
  }, [navigate]);
}
