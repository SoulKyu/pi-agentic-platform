import type { Caller } from "@pap/contracts";
import type { Agents } from "./service.ts";

/** The member's delete (A5b) asked the step-up for the whole account; each agent's trash move is done as that user. */
const asOwner = (ownerId: string): Caller => ({
  userId: ownerId,
  permissions: new Set(),
  kind: "session",
  credentialId: "user_delete",
  stepUpUntil: 0,
});

export interface AgentsOwnerCascade {
  /**
   * Every agent of the owner goes to the agent trash, one after the other (the same steps as `agents.delete`: triggers, queued
   * tasks, thread, VM, vault scope, home). The first failure stops it and is thrown, so a retry finds the rest. Returns how many.
   */
  trashAll(ownerId: string): Promise<number>;
}

export function createAgentsOwnerCascade(agents: Pick<Agents, "store" | "removeNow">): AgentsOwnerCascade {
  return {
    async trashAll(ownerId) {
      const records = agents.store.list(ownerId);
      for (const record of records) await agents.removeNow(asOwner(ownerId), record.id);
      return records.length;
    },
  };
}
