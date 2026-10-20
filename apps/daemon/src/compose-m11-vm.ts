import type { AgentsVm } from "./compose-agents-vm.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentEvents,
  type AgentsPort,
  createCrashPause,
  type RequestItems,
} from "./modules/agents/index.ts";

export type { AgentsVm };

/** What the VM composition adds to M11's three call sites; nothing in host mode. */
export interface VmPorts {
  /** Into the one `agents` object of `setAgentPorts`: it replaces the whole object, so it cannot be set apart. */
  readonly sessions: Partial<Pick<AgentsVm, "vmLayoutOf" | "agentRunsInVm">>;
  /** Into `createAgents`: the host's resource ceilings, the check of the package picks and the VM runtime's link (T15). */
  readonly agents: {
    resourceHost?: AgentsVm["resourceHost"];
    checkPackages?: AgentsVm["checkPackages"];
    vm?: AgentsVm["agentLink"];
  };
  /** Into `createAgentSafety`: no prompt chips from a host home. */
  readonly safety: Partial<Pick<AgentsVm, "agentRunsInVm">>;
}

const NONE: VmPorts = { sessions: {}, agents: {}, safety: {} };

/**
 * The VM wiring of composeM11 (`modules.vm`: `PAP_AGENTS_RUNTIME=vm`, absent in host mode). A predicate that is not wired stops
 * the boot (T8a, fail closed), because an agent row would otherwise run on the host; and a vm mode without this wiring is
 * stopped by `setAgentPorts`, which the sessions module (given a launcher) refuses without `vmLayoutOf` and `agentRunsInVm`.
 */
export function vmPortsOf(vm: AgentsVm | undefined): VmPorts {
  if (vm === undefined) return NONE;
  for (const name of ["vmLayoutOf", "agentRunsInVm", "resourceHost", "checkPackages"] as const)
    if (typeof vm[name] !== "function") throw new Error(`PAP_AGENTS_RUNTIME=vm: ${name} is not wired`);
  if (typeof vm.agentLink !== "object") throw new Error("PAP_AGENTS_RUNTIME=vm: agentLink is not wired");
  const { vmLayoutOf, agentRunsInVm, resourceHost, checkPackages, agentLink } = vm;
  return {
    sessions: { vmLayoutOf, agentRunsInVm },
    agents: { resourceHost, checkPackages, vm: agentLink },
    safety: { agentRunsInVm },
  };
}

/**
 * RT-40: three VM crashes in ten minutes pause the agent (persisted) and tell the owner. The registry, the cards and the Inbox are
 * built after the VM runtime, so the runtime's crash pause is bound here. Host mode: nothing.
 */
export function bindVmCrash(
  vm: AgentsVm | undefined,
  logger: Logger,
  parts: {
    agents: Parameters<typeof createCrashPause>[0]["agents"];
    events: Pick<AgentEvents, "notify">;
    items: Pick<RequestItems, "upsertAgentItem">;
  },
): void {
  vm?.bindCrashPause(createCrashPause({ ...parts, logger }));
}

/** The sessions' view of the agents registry: the profile of an owner's agent, null when there is none or it does not parse. */
export function sessionAgentsOf(agents: Pick<AgentsPort, "get">) {
  return (ownerId: string, agentId: string) => {
    const record = agents.get(ownerId, agentId);
    if (!record?.input) return null;
    return { input: record.input, name: record.name, quarantined: record.quarantinedAt !== null };
  };
}
