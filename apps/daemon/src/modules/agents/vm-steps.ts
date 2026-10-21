import type { AgentLinks, AgentVmLink } from "./links.ts";

/**
 * The delete's `vm` step (RT-40): every VM of the agent stops, then its disk goes to pap-vmd's trash and its mirrors to the
 * daemon's, and its imported files go to the files trash (spec 7; the credentials leave the live folder, host mode too). It runs
 * before the home moves, so a failure leaves the agent whole and a retry finds the rest undone.
 */
export async function deleteVmStep(
  vm: AgentVmLink | undefined,
  agentId: string,
  stamp: number,
  files?: AgentLinks["files"],
): Promise<void> {
  if (vm !== undefined) {
    await vm.stop(agentId);
    await vm.dispose(agentId, stamp);
  }
  files?.dispose(agentId, stamp);
}

/** Quarantine's `vm` step (RT-41), right after the pause: stop, revoke the launch and the relay grant, keep the disk. */
export async function quarantineVmStep(vm: AgentVmLink | undefined, agentId: string): Promise<void> {
  await vm?.stop(agentId);
}
