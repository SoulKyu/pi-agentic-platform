import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  disposeAgent,
  purgeAgent,
  startTrashSweep,
  type TrashDeps,
  type VmdClient,
} from "./modules/agent-vm/index.ts";
import { type AgentVmLink, removeTree } from "./modules/agents/index.ts";

export interface AgentsLinkContext {
  readonly runtime: Pick<AgentRuntime, "stop" | "resume">;
  /** pap-vmd; null under the process backend, which has no disk of its own. */
  readonly client: VmdClient | null;
  readonly papHome: string;
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Pick<Logger, "warn" | "info">;
  /** The agent is gone: the image policy's notice memory and its package pairs go. */
  forget(agentId: string): void;
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
  };
  return {
    link: {
      stop: (agentId) => ctx.runtime.stop(agentId),
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
