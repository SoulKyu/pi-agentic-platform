import { type AgentInput, type AgentResources, PapError } from "@pap/contracts";
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

/**
 * What a save checks against the host: the resource ceilings (RT-30) and the package ids (AVM-E33). Only what the save
 * changes is checked: a rename must not fail because the host's cap dropped (AVM-E17) or a package was removed since.
 */
export async function checkAgentSave(
  deps: {
    readonly resourceHost?: () => { memoryCapMb: number; cores: number };
    readonly checkPackages?: (ids: readonly string[]) => Promise<void>;
  },
  input: AgentInput,
  was: AgentInput | null,
  logger: Pick<Logger, "warn">,
): Promise<void> {
  const changed = (pick: (one: AgentInput) => unknown): boolean =>
    was === null || JSON.stringify(pick(input)) !== JSON.stringify(pick(was));
  if (deps.resourceHost && changed((one) => one.resources))
    checkAgentResources(input.resources, was?.resources ?? null, deps.resourceHost(), logger);
  if (deps.checkPackages && input.packages !== null && changed((one) => one.packages))
    await deps.checkPackages(input.packages);
}
