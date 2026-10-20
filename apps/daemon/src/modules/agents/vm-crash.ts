import { randomUUID } from "node:crypto";
import type { Logger } from "../../kernel/logger.ts";
import type { AgentEvents } from "./events.ts";
import type { AgentsPort } from "./service.ts";
import type { RequestItems } from "./requests.ts";

export interface CrashPauseDeps {
  /** The registry: its `setPaused` persists the pause and tells the listeners (the rail, the relay's policy). */
  readonly agents: {
    setPaused(ownerId: string, agentId: string, paused: boolean): unknown;
    readonly port: Pick<AgentsPort, "get" | "ownerOf">;
  };
  readonly events: Pick<AgentEvents, "notify">;
  readonly items: Pick<RequestItems, "upsertAgentItem">;
  readonly logger: Pick<Logger, "warn">;
}

/**
 * RT-40: the VM runtime saw the agent's VM exit three times in ten minutes. The agent's own pause is set (persisted, the owner's
 * Resume clears it) and the owner is told once, as `agent.notify` tells them: an Inbox item and a card in the agent's thread.
 */
export function createCrashPause(deps: CrashPauseDeps): (agentId: string) => void {
  return (agentId) => {
    const ownerId = deps.agents.port.ownerOf(agentId);
    const record = ownerId === null ? null : deps.agents.port.get(ownerId, agentId);
    if (ownerId === null || record === null) {
      deps.logger.warn("agent_vm_crash_pause_unknown_agent", { agentId });
      return;
    }
    deps.agents.setPaused(ownerId, agentId, true);
    const text = `${record.name} s'est arrêté trois fois en dix minutes ; il est en pause.`;
    const itemId = randomUUID();
    if (!deps.events.notify(ownerId, agentId, { text, itemId })) return;
    deps.items.upsertAgentItem({
      ownerId,
      kind: "agent_notify",
      agentId,
      refId: itemId,
      detail: text,
      toHandle: false,
    });
  };
}
