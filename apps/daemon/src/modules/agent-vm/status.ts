import { statSync } from "node:fs";
import { PapError, VmdHealth, type VmStatusView } from "@pap/contracts";
import type { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { ClaudeTokens } from "./claude-tokens.ts";
import type { VmPhase } from "./runtime.ts";
import type { VmdClient } from "./vmd-client.ts";

/** The sentences of the stack's state: `pap doctor` and `agents.vmStatus` print the same ones (R6, T1's view). */
export const STACK_REASONS = {
  kvm_missing: "this machine has no /dev/kvm: agents run in microVMs, which need KVM",
  unreachable: "pap-vmd does not answer: run `sudo pap vm setup`, then start pap-vmd",
  /** pap booted without a usable VM stack (no pap-vmd then, or a held port): its listeners stay off until it restarts. */
  restart:
    "pap started before its VM stack was ready, or a port on the bridge address was held; the rest of pap works: restart pap (`systemctl --user restart pap`) to start its agents",
  version: (found: string, pap: string): string =>
    `pap-vmd is at version ${found}, pap at ${pap}: run \`sudo pap vm setup\``,
  ruleset: "pap-vmd's firewall table is not loaded: run `sudo pap vm setup`",
  bridge: "pap-vmd's bridge pap0 is not up: run `sudo pap vm setup`",
} as const;

/** A launch asks pap-vmd at most this often; the owner's Recheck always asks. */
export const STACK_TTL_MS = 5_000;
/** The contract's bound on the agents a view lists. */
const VIEW_AGENTS_MAX = 32;

type Health = z.output<typeof VmdHealth>;

export interface StackAssessment {
  readonly usable: boolean;
  /** The sentence; null when usable. */
  readonly reason: string | null;
  readonly vmdVersion: string | null;
  /** What pap-vmd reported; null when it did not answer. */
  readonly health: Health | null;
}

/** `/dev/kvm` is a character device. */
export function hasKvm(): boolean {
  try {
    return statSync("/dev/kvm").isCharacterDevice();
  } catch {
    return false;
  }
}

/**
 * Whether the agents' VMs can start (R6, RT-40): `/dev/kvm` exists, pap-vmd answers `vmd.health`, runs pap's version, and has loaded its ruleset
 * and made pap0. The first fact that fails gives the sentence. Never throws: a pap-vmd that fails or answers nonsense is
 * unreachable.
 */
export async function assessStack(
  client: VmdClient,
  papVersion: string,
  kvm: () => boolean,
): Promise<StackAssessment> {
  if (!kvm()) return { usable: false, reason: STACK_REASONS.kvm_missing, vmdVersion: null, health: null };
  let health: Health;
  try {
    health = VmdHealth.parse(await client.request({ op: "vmd.health" }));
  } catch {
    return { usable: false, reason: STACK_REASONS.unreachable, vmdVersion: null, health: null };
  }
  const reason =
    health.version !== papVersion
      ? STACK_REASONS.version(health.version, papVersion)
      : !health.ruleset
        ? STACK_REASONS.ruleset
        : !health.bridge
          ? STACK_REASONS.bridge
          : null;
  return { usable: reason === null, reason, vmdVersion: health.version, health };
}

export interface VmStatusDeps {
  readonly clock: Pick<Clock, "now">;
  readonly logger: Pick<Logger, "warn">;
  /** The process backend (tests) has no pap-vmd: it answers a usable stack. */
  assess(): Promise<StackAssessment>;
  readonly claudeToken: Pick<ClaudeTokens, "status">;
  agentsOf(ownerId: string): ReadonlyArray<{ readonly id: string }>;
  phaseOf(agentId: string): VmPhase;
  /** The host's ceilings (`resourceHost`): the memory cap that running VMs share, and the cores. */
  host(): { readonly memoryCapMb: number; readonly cores: number };
  /** `PAP_MIN_FREE_DISK_MB`: the state folder's free space less this is what an agent's disk may still take. */
  readonly minFreeDiskMb: number;
}

export interface VmStatus {
  /** `agents.vmStatus`. Always asks pap-vmd: the page's Recheck button. */
  view(ownerId: string): Promise<VmStatusView>;
  /** The launch gate: `sandbox_unavailable` when the stack is unusable, with the sentence logged (a `PapError` carries only a code). */
  require(): Promise<void>;
}

const ceilings = (host: ReturnType<VmStatusDeps["host"]>, freeMb: number, floorMb: number) => ({
  memoryMb: Math.max(0, host.memoryCapMb - VM_OVERHEAD_MB),
  cpus: host.cores,
  diskMb: Math.max(0, freeMb - floorMb),
});

export function createVmStatus(deps: VmStatusDeps): VmStatus {
  let cached: { readonly at: number; readonly stack: StackAssessment } | null = null;
  async function fresh(): Promise<StackAssessment> {
    const stack = await deps.assess();
    cached = { at: deps.clock.now(), stack };
    return stack;
  }
  return {
    async view(ownerId) {
      const stack = await fresh();
      return {
        usable: stack.usable,
        reason: stack.reason,
        vmdVersion: stack.vmdVersion,
        claudeToken: deps.claudeToken.status(ownerId),
        // AVM-E33: what the form's fields may reach. Without an answer from pap-vmd there is nothing to promise.
        host:
          stack.health === null ? null : ceilings(deps.host(), stack.health.stateFreeMb, deps.minFreeDiskMb),
        agents: deps
          .agentsOf(ownerId)
          .slice(0, VIEW_AGENTS_MAX)
          .map(({ id }) => ({ id, phase: deps.phaseOf(id) })),
      };
    },
    async require() {
      const known = cached;
      const stack =
        known !== null && deps.clock.now() - known.at < STACK_TTL_MS ? known.stack : await fresh();
      if (stack.usable) return;
      deps.logger.warn("agent_vm_launch_refused", { reason: stack.reason });
      throw new PapError("sandbox_unavailable");
    },
  };
}
