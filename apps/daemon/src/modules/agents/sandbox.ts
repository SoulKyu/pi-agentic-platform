import { EGRESS_UNKNOWN, type EgressStatus, PapError, type SandboxStatus } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { CheckedProbe, SandboxProbe } from "../../kernel/sandbox/probe.ts";

/** At most one re-probe in this window (M11R19): a button held down does not spawn bwrap in a loop. */
export const RECHECK_EVERY_MS = 10_000;

/** What the two sandbox methods read of the probe service. */
export interface SandboxProbeLike {
  current(): CheckedProbe;
  recheck(): Promise<SandboxProbe>;
}

/** What the two sandbox methods read of the egress proxy (M11R242). */
export interface EgressLike {
  status(): EgressStatus;
  recheck(): Promise<void>;
}

const statusOf = (probe: CheckedProbe, egress: EgressStatus): SandboxStatus => ({
  usable: probe.usable,
  path: probe.usable ? probe.path : null,
  reason: probe.usable ? null : probe.reason,
  checkedAt: probe.checkedAt,
  egress,
});

/**
 * `agents.sandboxStatus` and `agents.recheckSandbox` (M11R20, M11R19): one service call each. The status carries the egress
 * proxy's (M11R242); "Check again" probes its interpreter too. Without a proxy bound the status reads as unusable.
 */
export function createSandboxMethods(
  probe: SandboxProbeLike,
  clock: Pick<Clock, "now">,
  egress?: EgressLike,
) {
  let lastRecheck = Number.NEGATIVE_INFINITY;
  const egressNow = (): EgressStatus => egress?.status() ?? EGRESS_UNKNOWN;
  return {
    status: (): SandboxStatus => statusOf(probe.current(), egressNow()),
    async recheck(): Promise<SandboxStatus> {
      const now = clock.now();
      if (now - lastRecheck < RECHECK_EVERY_MS) throw new PapError("rate_limited");
      lastRecheck = now;
      await Promise.all([probe.recheck(), egress?.recheck()]);
      return statusOf(probe.current(), egressNow());
    },
  };
}
export type SandboxMethods = ReturnType<typeof createSandboxMethods>;
