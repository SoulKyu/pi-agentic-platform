import type { AutomationSettings } from "@pap/contracts";
import type { AgentBinding } from "./trigger-agent.ts";

export interface AgentBudgetDeps {
  readonly binding: AgentBinding;
  readonly settings: { automation(ownerId: string): Pick<AutomationSettings, "timezone"> };
}

/**
 * The agent's own daily budget (M11R74, owner m14): none by default. It is read from the profile at each gate, so a set
 * or cleared budget applies at once; a budget of 0 is reached before anything runs, null is no line. The spend is what the
 * runs registry says of the agent's runs today: its thread, its tasks and its children, the open ones included.
 * M10's owner-wide budget applies on top, in `gates`.
 */
export function createAgentBudget(deps: AgentBudgetDeps) {
  return {
    over(ownerId: string, agentId: string): boolean {
      const ports = deps.binding.ports();
      const budget = ports?.registry.get(ownerId, agentId)?.input?.budget;
      if (!ports || !budget || (budget.usdPerDay === null && budget.tokensPerDay === null)) return false;
      const spent = ports.spend.agentSpentToday(ownerId, agentId, deps.settings.automation(ownerId).timezone);
      return (
        (budget.usdPerDay !== null && spent.usd >= budget.usdPerDay) ||
        (budget.tokensPerDay !== null && spent.tokens >= budget.tokensPerDay)
      );
    },
  };
}
export type AgentBudget = ReturnType<typeof createAgentBudget>;
