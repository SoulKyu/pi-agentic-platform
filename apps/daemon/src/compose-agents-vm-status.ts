import { AGENT_NET, PapError } from "@pap/contracts";
import type { VmLaunch } from "./modules/sessions/index.ts";
import { availableParallelism } from "node:os";
import { VERSION } from "./kernel/version.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  assessStack,
  type BundleSkew,
  type ClaudeTokenStore,
  createBundleSkew,
  createVmStatus,
  hasKvm,
  type KataImages,
  STACK_REASONS,
  treeBundleOf,
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
  /** `down`: the bridge or a listener never came at boot, so the composition listens on loopback and no launch may go on. */
  stack: { readonly kvm?: () => boolean; readonly down?: () => boolean } = {},
): { readonly status: VmStatus; bindAgents(agents: Pick<AgentsPort, "list">): void } {
  let agents: Pick<AgentsPort, "list"> | null = null;
  const status = createVmStatus({
    clock: core.clock,
    logger: core.logger,
    assess: async () => {
      if (!client) return NO_VMD;
      const found = await assessStack(client, VERSION, stack.kvm ?? hasKvm);
      // Down mode lasts until pap restarts: once the stack itself is fine again (after `sudo pap vm setup`, or a freed port),
      // the one thing left to do is the restart, and the status says so instead of the stale "pap-vmd does not answer".
      return stack.down?.() && found.usable
        ? { ...found, usable: false, reason: STACK_REASONS.restart }
        : found;
    },
    claudeToken: core.claudeToken,
    agentsOf: (ownerId) => agents?.list(ownerId) ?? [],
    phaseOf: runtime.phase,
    host: resourceHostOf(core.config),
    minFreeDiskMb: core.config.minFreeDiskMb,
  });
  return { status, bindAgents: (port) => void (agents = port) };
}

/** The relay's readiness as the launch gate asks for it: ready once it listens on the bridge's own port. */
export const relayGateOf = (
  relay: { port(): number | null; whenReady(signal: AbortSignal): Promise<void> },
  clock: RelayGate["clock"],
): RelayGate => ({
  ready: () => relay.port() === AGENT_NET.relayPort,
  whenReady: (signal) => relay.whenReady(signal),
  clock,
});

/** The stale-bundle check of the Kata backend: the installed bundle against the one built with this daemon. */
export const skewOf = (
  images: Pick<KataImages, "installedDigest" | "digestOf">,
  logger: Logger,
): BundleSkew =>
  createBundleSkew({
    treeBundle: treeBundleOf(import.meta.dirname),
    installedDigest: async (fresh) => images.installedDigest(fresh),
    treeDigest: async (dir) => images.digestOf(dir),
    logger,
  });

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
  skew?: Pick<BundleSkew, "check">,
): VmLaunch => ({
  async spawn(row, agentLaunch, init) {
    if (relay !== undefined && !(await relayIsReady(relay))) throw new PapError("sandbox_unavailable");
    await status.require();
    if (skew !== undefined && row.agentId !== undefined && (await skew.check(row.agentId)) === "stale")
      throw new PapError("vm_bundle_stale");
    return launch.spawn(row, agentLaunch, init);
  },
});
