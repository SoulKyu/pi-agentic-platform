import { type AgentResources, PapError } from "@pap/contracts";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";

/** A `bad_request` that names the field of `resources` the host refuses (the form marks it). */
export class ResourcesRefused extends PapError {
  readonly field: keyof AgentResources;
  constructor(field: keyof AgentResources) {
    super("bad_request");
    this.field = field;
  }
}

/** RT-30, spec §7: the ceilings that depend on the host, checked at save. The disk only grows. */
export function checkAgentResources(
  input: AgentResources,
  was: AgentResources | null,
  host: { memoryCapMb: number; cores: number },
): void {
  if (input.memoryMb + VM_OVERHEAD_MB > host.memoryCapMb) throw new ResourcesRefused("memoryMb");
  if (input.cpus > host.cores) throw new ResourcesRefused("cpus");
  if (was !== null && input.diskMb < was.diskMb) throw new ResourcesRefused("diskMb");
}
