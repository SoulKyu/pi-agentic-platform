import { PapError } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";

/** What stopping an account's machines needs of the modules that own the rows (the box control, the agents' VM link). */
export interface DisableDeps {
  readonly boxes: {
    ownerBoxes(ownerId: string): readonly string[];
    stop(projectId: string): Promise<void>;
  };
  readonly agents: { list(ownerId: string): ReadonlyArray<{ readonly id: string }> };
  /** Stops every VM of the agent and leaves its disk. */
  stopAgent(agentId: string): Promise<void>;
  /** The user's preview tokens (a lease or an HTML artifact) die with their account (UX2-R72). */
  readonly previews: { revokeOwner(ownerId: string): unknown };
  readonly logger: Pick<Logger, "warn">;
}

export interface Disabling {
  /**
   * Revokes the user's preview tokens, then stops every box and agent VM of the user; the data stays. Each stop is tried whatever the others do, and a failure is
   * answered `internal` after the last one, so the owner can retry: the account is already disabled, and the launch gate and
   * the relay's `paused` hold the VMs that did not stop from doing more.
   */
  stopAll(userId: string): Promise<void>;
}

export function createDisabling(deps: DisableDeps): Disabling {
  return {
    async stopAll(userId) {
      // First and unconditional: a stop that fails below must not leave a page open on a disabled account's box.
      deps.previews.revokeOwner(userId);
      let failed = false;
      const attempt = async (what: string, id: string, work: () => Promise<void>): Promise<void> => {
        try {
          await work();
        } catch (error) {
          failed = true;
          deps.logger.warn("user_disable_stop_failed", { what, id, err: error });
        }
      };
      for (const projectId of deps.boxes.ownerBoxes(userId))
        await attempt("box", projectId, () => deps.boxes.stop(projectId));
      for (const agent of deps.agents.list(userId))
        await attempt("agent", agent.id, () => deps.stopAgent(agent.id));
      if (failed) throw new PapError("internal");
    },
  };
}
