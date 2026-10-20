import type { VmLaunch } from "./modules/sessions/index.ts";
import { availableParallelism } from "node:os";
import { VERSION } from "./kernel/version.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  assessStack,
  type ClaudeTokenStore,
  createVmStatus,
  type StackAssessment,
  type VmdClient,
  type VmStatus,
} from "./modules/agent-vm/index.ts";
import type { AgentsPort } from "./modules/agents/index.ts";

/** The host's ceilings for one agent (RT-30): the memory cap, shared by the running VMs, and the cores. */
export const resourceHostOf = (config: Pick<Config, "agentsMemoryMaxMb">) => () => ({
  memoryCapMb: config.agentsMemoryMaxMb,
  cores: availableParallelism(),
});

/** The process backend (tests) has no pap-vmd: its stack is always usable, and says nothing of the host's disk. */
const NO_VMD: StackAssessment = { usable: true, reason: null, vmdVersion: null, health: null };

/**
 * `agents.vmStatus` and the launch refusal (T18). The agents' list is bound with the agents module, which is built after the
 * VM runtime; until then a view lists none.
 */
export function composeVmStatus(
  core: {
    readonly clock: Clock;
    readonly logger: Logger;
    readonly claudeToken: ClaudeTokenStore;
    readonly config: Pick<Config, "agentsMemoryMaxMb" | "minFreeDiskMb">;
  },
  client: VmdClient | null,
  runtime: Pick<AgentRuntime, "phase">,
): { readonly status: VmStatus; bindAgents(agents: Pick<AgentsPort, "list">): void } {
  let agents: Pick<AgentsPort, "list"> | null = null;
  const status = createVmStatus({
    clock: core.clock,
    logger: core.logger,
    assess: client ? () => assessStack(client, VERSION) : async () => NO_VMD,
    claudeToken: core.claudeToken,
    agentsOf: (ownerId) => agents?.list(ownerId) ?? [],
    phaseOf: runtime.phase,
    host: resourceHostOf(core.config),
    minFreeDiskMb: core.config.minFreeDiskMb,
  });
  return { status, bindAgents: (port) => void (agents = port) };
}

/** A launch of an unusable stack is refused `sandbox_unavailable` before anything is built or spawned. */
export const guardedLaunch = (launch: VmLaunch, status: Pick<VmStatus, "require">): VmLaunch => ({
  async spawn(row, agentLaunch, init) {
    await status.require();
    return launch.spawn(row, agentLaunch, init);
  },
});
