import type { AgentVmLink } from "./links.ts";

/**
 * The delete's `vm` step (RT-40): every VM of the agent stops, then its disk goes to pap-vmd's trash and its mirrors to the
 * daemon's. It runs before the home moves, so a failure leaves the agent whole and a retry finds the rest undone. Host mode: nothing.
 */
export async function deleteVmStep(
  vm: AgentVmLink | undefined,
  agentId: string,
  stamp: number,
): Promise<void> {
  if (vm === undefined) return;
  await vm.stop(agentId);
  await vm.dispose(agentId, stamp);
}

/** Quarantine's `vm` step (RT-41), right after the pause: stop, revoke the launch and the relay grant, keep the disk. */
export async function quarantineVmStep(vm: AgentVmLink | undefined, agentId: string): Promise<void> {
  await vm?.stop(agentId);
}
