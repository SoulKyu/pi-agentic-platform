import { MAX_ALLOW_HOSTS, type VmLayout } from "@pap/contracts";
import type { ProjectBoxRow } from "../../kernel/boxes.ts";
import type { AgentRuleParts, OwnerLists } from "./agent-rules.ts";

/**
 * The project profile's part of a session's rules (spec boxes, task A3): the owner's mode and lists stay (a task keeps its own
 * mode), the session's own folder is the project folder, and the box's shell has the network behind the egress proxy. The proxy
 * is what guarantees hosts (owner's list plus the project's); the rules carry the same union for the worker's own stage, cut at
 * what the schema holds. The owner's "always" grants were made for host calls and never cross into a box (AVM-E18).
 */
export function projectRuleParts(
  layout: VmLayout,
  owner: OwnerLists,
  box: Pick<ProjectBoxRow, "hosts">,
  hostGrants: readonly string[],
): AgentRuleParts {
  const hosts =
    owner.allowHosts === null && box.hosts.length === 0
      ? null
      : [...new Set([...(owner.allowHosts ?? []), ...box.hosts])].slice(0, MAX_ALLOW_HOSTS);
  return {
    profile: "project",
    allowHosts: hosts,
    agentHome: layout.project ?? layout.home,
    agentScratch: null,
    sandbox: { required: true, network: true },
    hostGrants: [...hostGrants],
    alwaysAllow: [],
    alwaysPrefixes: [],
    alwaysTools: [],
  };
}
