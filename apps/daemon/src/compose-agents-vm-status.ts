import { AGENT_NET, type BoxRef, PapError } from "@pap/contracts";
import type { VmLaunch } from "./modules/sessions/index.ts";
import { availableParallelism } from "node:os";
import { VERSION } from "./kernel/version.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import { type LaunchHandle, type LaunchRegistry, launchCodeOf, stepAround } from "./kernel/launches.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  assessStack,
  type BundleSkew,
  type ClaudeTokens,
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
    readonly claudeToken: ClaudeTokens;
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
    phaseOf: (agentId) => runtime.phase({ kind: "agent", id: agentId }),
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
    installedDigest: (fresh) => images.installedDigest(fresh),
    treeDigest: (dir) => images.digestOf(dir),
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

async function relayIsReady(gate: RelayGate, launch?: Pick<LaunchHandle, "wait">): Promise<boolean> {
  if (gate.ready()) return true;
  launch?.wait({ reason: "relay" });
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
    launch?.wait(null);
  }
  return gate.ready();
}

/**
 * What a launch checks before it starts a VM, and a box's start checks too: an unusable stack is `sandbox_unavailable`, and so is
 * a relay that has not reported ready (S1, AVM-E49 M9b: one that could not bind the bridge's port never becomes ready, and a VM
 * started meanwhile would talk to whoever does listen there; a launch in the seconds after boot waits for it, bounded by
 * `RELAY_READY_WAIT_MS`); an installed bundle older than the one built with this daemon is `vm_bundle_stale`. `relay` is absent
 * without a relay, `box` null for a launch that is in no box. The relay wait is told to `launch` as `waiting: relay`; the `checks`
 * step is the caller's.
 */
export const launchGate =
  (
    status: Pick<VmStatus, "require">,
    relay?: RelayGate,
    skew?: Pick<BundleSkew, "check">,
    /** A disabled owner's box never starts (M14 RT-03): a worker restart or a queued start meets this too. */
    disabled?: (box: BoxRef) => boolean,
  ) =>
  async (box: BoxRef | null, launch?: Pick<LaunchHandle, "wait">): Promise<void> => {
    if (box !== null && disabled?.(box) === true) throw new PapError("account_disabled");
    if (relay !== undefined && !(await relayIsReady(relay, launch)))
      throw new PapError("sandbox_unavailable");
    await status.require();
    if (skew !== undefined && box !== null && (await skew.check(box)) === "stale")
      throw new PapError("vm_bundle_stale");
  };

/** A launch goes through `launchGate` of its own box (an agent's, or a project's) before anything is built or spawned. */
export const guardedLaunch = (
  launch: VmLaunch,
  status: Pick<VmStatus, "require">,
  relay?: RelayGate,
  skew?: Pick<BundleSkew, "check">,
  disabled?: (box: BoxRef) => boolean,
  launches?: Pick<LaunchRegistry, "open">,
): VmLaunch => {
  const gate = launchGate(status, relay, skew, disabled);
  return {
    async spawn(row, agentLaunch, init) {
      const box: BoxRef | null =
        "project" in agentLaunch
          ? { kind: "project", id: agentLaunch.project.id }
          : row.agentId === undefined
            ? null
            : { kind: "agent", id: row.agentId };
      // The launch opens here so `checks` is its first step; the one that spawns ends it on a refusal, the session layer when ready.
      const opened = box === null ? undefined : launches?.open({ box, owner: row.ownerId, for: row.id });
      try {
        await stepAround(opened, "checks", () => gate(box, opened));
        // The gate awaits (relay, stack, skew): an account disabled meanwhile is met again right before the spawn.
        if (box !== null && disabled?.(box) === true) throw new PapError("account_disabled");
        return await (opened
          ? launch.spawn(row, agentLaunch, init, opened)
          : launch.spawn(row, agentLaunch, init));
      } catch (error) {
        opened?.end(false, launchCodeOf(error));
        throw error;
      }
    },
  };
};
