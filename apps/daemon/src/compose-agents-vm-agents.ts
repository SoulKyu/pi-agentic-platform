import { z } from "zod";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  disposeAgent,
  purgeAgent,
  startTrashSweep,
  type TrashDeps,
  papErrorOf,
  type VmdClient,
  VmdError,
} from "./modules/agent-vm/index.ts";
import { type AgentVmLink, removeTree } from "./modules/agents/index.ts";

const Listing = z.object({
  vms: z.array(z.object({ agentId: z.string(), taskKey: z.string().nullable(), state: z.string() })),
});

/**
 * I1: the runtime forgets a VM even when pap-vmd failed to stop it (its stop is logged, not thrown). Quarantine and delete must
 * not: pap-vmd is asked for the agent's VMs and each one that is not stopped is stopped, and any failure is thrown, after every
 * VM was tried, so a second ask finishes what the first could not.
 */
async function stopListed(
  client: VmdClient,
  stopVm: AgentsLinkContext["stopVm"],
  agentId: string,
): Promise<void> {
  try {
    const listed = Listing.safeParse(await client.request({ op: "vm.list" }));
    if (!listed.success) throw new VmdError("protocol");
    let failed: unknown;
    for (const vm of listed.data.vms) {
      if (vm.agentId !== agentId || vm.state === "stopped") continue;
      try {
        await stopVm(agentId, vm.taskKey);
      } catch (error) {
        failed ??= error;
      }
    }
    if (failed !== undefined) throw failed;
  } catch (error) {
    throw papErrorOf(error);
  }
}

export interface AgentsLinkContext {
  readonly runtime: Pick<AgentRuntime, "stop" | "resume">;
  /** pap-vmd; null under the process backend, which has no disk of its own. */
  readonly client: VmdClient | null;
  /**
   * Stops one VM through the Kata backend (S1): queued with its starts and stops, and it clears the image policy's record of the
   * thread VM, so the next thread VM takes the image that is current, not the one the stopped VM ran on.
   */
  stopVm(agentId: string, taskKey: string | null): Promise<void>;
  /** The stack gate (`VmStatus.require`): `agents.create` is refused `sandbox_unavailable` while it is unusable. */
  require(): Promise<void>;
  readonly papHome: string;
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Pick<Logger, "warn" | "info">;
  /** The agent is gone: the image policy's notice memory and its package pairs go. */
  forget(agentId: string): void;
  /** The agent file store's trash, purged and swept with the disk's and the mirrors'. */
  readonly files?: TrashDeps["files"] | undefined;
}

/**
 * What the agents module asks of the VM runtime (T15): the stop of a delete, a quarantine and a Resume, the disk and mirrors of a
 * delete, "Purge now", and the daily sweep of the daemon's trash (RT-40). Returns the link and the way to stop the sweep.
 */
export function composeAgentsLink(ctx: AgentsLinkContext): { link: AgentVmLink; stopSweep: () => void } {
  const trash: TrashDeps = {
    client: ctx.client,
    papHome: ctx.papHome,
    clock: ctx.clock,
    logger: ctx.logger,
    remove: removeTree,
    ...(ctx.files === undefined ? {} : { files: ctx.files }),
  };
  return {
    link: {
      require: ctx.require,
      async stop(agentId) {
        await ctx.runtime.stop(agentId);
        if (ctx.client !== null) await stopListed(ctx.client, ctx.stopVm, agentId);
      },
      async dispose(agentId, stamp) {
        await disposeAgent(trash, agentId, stamp);
        ctx.forget(agentId);
      },
      purge: (agentId) => purgeAgent(trash, agentId),
      resume: (agentId) => ctx.runtime.resume(agentId),
    },
    stopSweep: startTrashSweep(trash),
  };
}
