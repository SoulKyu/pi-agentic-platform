import { type Caller, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import type { AgentLinks } from "./links.ts";
import type { AgentStore } from "./store.ts";
import { actorOf } from "./view.ts";

export interface TrashPurgeDeps {
  readonly store: Pick<AgentStore, "inTrash" | "dropTrash">;
  /** Read at each call: the VM link is bound with the agents module, but only in `vm` mode. */
  readonly links: () => AgentLinks;
  readonly clock: Pick<Clock, "now">;
  readonly audit: Pick<AuditPort, "append">;
  readonly logger: Pick<Logger, "error">;
  readonly requireStepUp: (caller: Caller, now: number) => void;
}

/**
 * `agents.purgeTrash` (RT-40): "Purge now" for a deleted VM agent. The entry names the owner, so it is the only proof a caller owns
 * the trash; the purge itself (pap-vmd's `trash.purge` and the mirrors' trash) runs first and the entry goes after it, so a failure
 * can be asked again. Nothing else depends on the entry: pap-vmd's own sweep removes a disk after 7 days whether or not it is there.
 */
export function createTrashPurge(deps: TrashPurgeDeps) {
  return {
    async purge(caller: Caller, agentId: string): Promise<void> {
      const vm = deps.links().vm;
      if (vm === undefined) throw new PapError("sandbox_unavailable");
      deps.requireStepUp(caller, deps.clock.now());
      if (!deps.store.inTrash(caller.userId, agentId)) throw new PapError("not_found");
      try {
        await vm.purge(agentId);
      } catch (error) {
        if (error instanceof PapError) throw error;
        deps.logger.error("agent_trash_purge_failed", { agentId, err: error });
        throw new PapError("command_failed");
      }
      deps.store.dropTrash(caller.userId, agentId);
      deps.audit.append({
        ownerId: caller.userId,
        ...actorOf(caller),
        kind: "policy",
        reason: "agent trash purged",
        detail: { agentId },
      });
    },
  };
}
export type TrashPurge = ReturnType<typeof createTrashPurge>;
