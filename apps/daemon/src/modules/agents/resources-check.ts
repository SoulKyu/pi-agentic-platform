import type { AgentInput } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import { checkAgentResources } from "../../kernel/resources-check.ts";

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
