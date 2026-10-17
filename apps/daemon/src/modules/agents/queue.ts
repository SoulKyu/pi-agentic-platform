import { type Caller, PapError, type ParamsOf, type ResultOf } from "@pap/contracts";
import type { AgentLinks } from "./links.ts";
import type { AgentStore } from "./store.ts";

export interface QueueDeps {
  readonly store: Pick<AgentStore, "get">;
  /** Read at each call: the links are bound after the module is built. */
  readonly links: () => AgentLinks;
}

/**
 * `agents.queueTask` (M11R77): a thread task for the agent, by the owner's hand. Browser sessions only: a token drives no
 * agent (`forbidden`). A paused agent queues it and runs it on resume; a quarantined one refuses (`agent_paused`).
 */
export function createQueueTask(deps: QueueDeps) {
  return function queueTask(
    caller: Caller,
    params: ParamsOf<"agents.queueTask">,
  ): ResultOf<"agents.queueTask"> {
    if (caller.kind !== "session") throw new PapError("forbidden");
    const { agentId, prompt, handOff } = params;
    const record = deps.store.get(caller.userId, agentId);
    if (!record) throw new PapError("not_found");
    if (record.quarantinedAt !== null) throw new PapError("agent_paused");
    const source = handOff ? deps.store.get(caller.userId, handOff.fromAgentId) : null;
    if (handOff && !source) throw new PapError("not_found");
    const queue = deps.links().automation?.queueTask;
    if (!queue) throw new PapError("not_found");
    return queue({
      ownerId: caller.userId,
      agentId,
      prompt,
      handOff: handOff && source ? { fromName: source.name, quote: handOff.quote } : null,
    });
  };
}
export type QueueTask = ReturnType<typeof createQueueTask>;
