import { PapError } from "@pap/contracts";
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

/** M3: a launch right after boot waits this long for the relay to report ready, then is refused. */
export const RELAY_READY_WAIT_MS = 30_000;

export interface RelayGate {
  /** The relay reported ready on the bridge's own port. */
  readonly ready: () => boolean;
  readonly whenReady: (signal: AbortSignal) => Promise<void>;
  readonly clock: Pick<Clock, "setTimeout" | "clearTimeout">;
}

async function relayIsReady(gate: RelayGate): Promise<boolean> {
  if (gate.ready()) return true;
  const giveUp = new AbortController();
  let timer: ReturnType<Clock["setTimeout"]> | null = null;
  const timedOut = new Promise<void>(
    (resolve) => void (timer = gate.clock.setTimeout(resolve, RELAY_READY_WAIT_MS)),
  );
  try {
    await Promise.race([gate.whenReady(giveUp.signal), timedOut]);
  } finally {
    giveUp.abort();
    if (timer !== null) gate.clock.clearTimeout(timer);
  }
  return gate.ready();
}

/**
 * A launch of an unusable stack is refused `sandbox_unavailable` before anything is built or spawned. So is one while the relay
 * has not reported ready (S1, AVM-E49 M9b): a relay that could not bind the bridge's port (another process holds it) never
 * becomes ready, and a VM started meanwhile would talk to whoever does listen there. A launch in the seconds after boot waits
 * for the relay, bounded by `RELAY_READY_WAIT_MS`. `relay` is absent without a relay.
 */
export const guardedLaunch = (
  launch: VmLaunch,
  status: Pick<VmStatus, "require">,
  relay?: RelayGate,
): VmLaunch => ({
  async spawn(row, agentLaunch, init) {
    if (relay !== undefined && !(await relayIsReady(relay))) throw new PapError("sandbox_unavailable");
    await status.require();
    return launch.spawn(row, agentLaunch, init);
  },
});
