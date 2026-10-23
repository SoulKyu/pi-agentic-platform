import type { VmLayout } from "@pap/contracts";
import type { AgentRuleParts } from "./agent-rules.ts";

/** What a VM session cannot do in sub-project 1, in English for the logs (the French copy is the web catalogs', T19). */
export const VM_REFUSALS = {
  /** R16. */
  precheck: "Prechecks of a VM agent arrive with sub-project 3.",
  /** R37. */
  export: "HTML export of a VM agent arrives later.",
} as const;

/**
 * R15 (AVM2-E11 supersedes "no network until sub-project 2"): a VM session is judged like a sandboxed shell, whatever the
 * profile's host-sandbox switch says; the shell's network is the agent's own `sandbox.network` and goes through the egress
 * proxy. Its folders are the VM's (no host path reaches its rules). Pure: it holds before the VM starts and at every compose.
 */
export function vmRuleParts(parts: AgentRuleParts, layout: VmLayout, isTask: boolean): AgentRuleParts {
  return {
    ...parts,
    agentHome: layout.home,
    agentScratch: isTask ? layout.home : null,
    sandbox: { required: true, network: parts.sandbox?.network === true },
    // AVM-E18: the owner's "always" grants were made for host calls and never cross into the box.
    alwaysAllow: [],
    alwaysPrefixes: [],
    alwaysTools: [],
  };
}
