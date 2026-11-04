import { PapError } from "@pap/contracts";

export interface AgentStopDeps {
  /** The start in flight for this agent (`createAgentStart`), if any. */
  inflight(agentId: string): Promise<void> | undefined;
  /** The agents link's stop: the runtime's stop, then the VMs pap-vmd still lists for the agent. */
  stop(agentId: string): Promise<void>;
  ownerOf(agentId: string): string | null;
}

/**
 * `agents.stopBox`: an agent's VM stops. A start still in flight settles first (its failure is the starter's, not ours), so the
 * stop never lands before the VM it is meant for. A stopped agent is already done.
 */
export function createAgentStop(deps: AgentStopDeps): (ownerId: string, agentId: string) => Promise<void> {
  return async (ownerId, agentId) => {
    if (deps.ownerOf(agentId) !== ownerId) throw new PapError("not_found");
    await deps.inflight(agentId)?.catch(() => undefined);
    await deps.stop(agentId);
  };
}
