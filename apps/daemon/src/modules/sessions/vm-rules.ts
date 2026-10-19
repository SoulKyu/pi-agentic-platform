import type { VmLayout } from "@pap/contracts";
import type { AgentRuleParts } from "./agent-rules.ts";

/** What a VM session cannot do in sub-project 1: French for the catalogs, English for the logs. */
export const VM_REFUSALS = {
  /** R11. */
  vault: {
    fr: "Le coffre des agents en VM arrive avec le sous-projet 2.",
    en: "The vault of VM agents arrives with sub-project 2.",
  },
  /** R16. */
  precheck: {
    fr: "Les pré-checks d'un agent en VM arrivent avec le sous-projet 3.",
    en: "Prechecks of a VM agent arrive with sub-project 3.",
  },
  /** R37. */
  export: {
    fr: "L'export HTML d'un agent en VM arrive plus tard.",
    en: "HTML export of a VM agent arrives later.",
  },
} as const;

/**
 * R15: a VM session is judged like a sandboxed shell without network, whatever the profile's host-sandbox switch says,
 * and its folders are the VM's (no host path reaches its rules). Pure: it holds before the VM starts and at every compose.
 */
export function vmRuleParts(parts: AgentRuleParts, layout: VmLayout, isTask: boolean): AgentRuleParts {
  return {
    ...parts,
    agentHome: layout.home,
    agentScratch: isTask ? layout.home : null,
    sandbox: { required: true, network: false },
  };
}
