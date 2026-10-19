import { type AgentResources, PapError } from "@pap/contracts";
import { VM_OVERHEAD_MB } from "../../kernel/config-agents-vm.ts";
import type { Logger } from "../../kernel/logger.ts";

/**
 * RT-30, spec §7: the ceilings that depend on the host, checked at save. The disk only grows. A refusal is a plain
 * `bad_request` (the dispatcher carries no field): the field is logged, and the form checks the ceilings it shows.
 */
export function checkAgentResources(
  input: AgentResources,
  was: AgentResources | null,
  host: { memoryCapMb: number; cores: number },
  logger: Pick<Logger, "warn">,
): void {
  const field =
    input.memoryMb + VM_OVERHEAD_MB > host.memoryCapMb
      ? "memoryMb"
      : input.cpus > host.cores
        ? "cpus"
        : was !== null && input.diskMb < was.diskMb
          ? "diskMb"
          : null;
  if (field === null) return;
  logger.warn("agent_resources_refused", { field });
  throw new PapError("bad_request");
}
