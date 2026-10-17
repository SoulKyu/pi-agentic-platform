import type { AgentInput } from "@pap/contracts";
import type { AgentSpend } from "../runs/index.ts";

export interface AgentOverDeps {
  /** The agent's own budget as the registry holds it now; null when the agent or its profile is unreadable. */
  budgetOf(ownerId: string, agentId: string): AgentInput["budget"] | null;
  readonly spend: Pick<AgentSpend, "agentSpentToday">;
  timeZone(ownerId: string): string | null;
}

/**
 * The agent's own daily budget is reached (M11R74, M11R137): what its runs cost today, its children's included, against the
 * profile read now. 0 is reached before anything runs; null is no line. M10's owner-wide budget is not asked here: a child
 * of a thread is the owner's own work (the thread's messages are counted, never gated).
 */
export function createAgentOver(deps: AgentOverDeps) {
  return function over(ownerId: string, agentId: string): boolean {
    const budget = deps.budgetOf(ownerId, agentId);
    if (!budget || (budget.usdPerDay === null && budget.tokensPerDay === null)) return false;
    const spent = deps.spend.agentSpentToday(ownerId, agentId, deps.timeZone(ownerId));
    return (
      (budget.usdPerDay !== null && spent.usd >= budget.usdPerDay) ||
      (budget.tokensPerDay !== null && spent.tokens >= budget.tokensPerDay)
    );
  };
}
