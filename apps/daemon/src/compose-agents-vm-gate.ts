import { type BoxRef, PapError } from "@pap/contracts";
import type { Clock } from "./kernel/clock.ts";
import type { LaunchRegistry } from "./kernel/launches.ts";
import type { Logger } from "./kernel/logger.ts";
import type { BoxStack } from "./compose-boxes-wiring.ts";
import type { composeKata } from "./compose-agents-vm-kata.ts";
import type { AgentsVmDerived } from "./compose-agents-vm-late.ts";
import type { AgentsVmSeams } from "./compose-agents-vm-seams.ts";
import { guardedLaunch, launchGate, relayGateOf, skewOf } from "./compose-agents-vm-status.ts";
import type { VmLaunch } from "./modules/sessions/index.ts";
import type { VmStatus } from "./modules/agent-vm/index.ts";

export interface LaunchGateContext {
  readonly baseLaunch: VmLaunch;
  readonly status: Pick<VmStatus, "require">;
  readonly kata: ReturnType<typeof composeKata> | null;
  /** The relay, or null when there is none or the stack is down: no relay gate then. */
  readonly relay: Parameters<typeof relayGateOf>[0] | null;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly bundleSkew: AgentsVmSeams["bundleSkew"];
  readonly late: () => AgentsVmDerived | null;
  readonly launches?: Pick<LaunchRegistry, "open">;
}

/** The launch gate of the VM stack, moved out of `composeAgentsVm` as is: the guarded launcher and the box start's gate. */
export function composeLaunchGate(context: LaunchGateContext): {
  readonly launch: VmLaunch;
  readonly gate: BoxStack["gate"];
} {
  const { baseLaunch, status, kata, relay, clock, logger, late } = context;
  const relayGate = kata && relay ? relayGateOf(relay, clock) : undefined;
  // Before the late binding nothing says whose a box is: a launch then fails closed, never open (M14 J1).
  const disabledBox = (box: BoxRef): boolean => {
    const bound = late();
    if (bound === null) throw new PapError("sandbox_unavailable");
    return bound.boxDisabled(box);
  };
  const skew = context.bundleSkew ?? (kata ? skewOf(kata.images, logger) : undefined);
  return {
    launch: guardedLaunch(baseLaunch, status, relayGate, skew, disabledBox, context.launches),
    gate: launchGate(status, relayGate, skew, disabledBox),
  };
}
