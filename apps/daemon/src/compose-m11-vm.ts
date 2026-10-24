import type { AgentsVm } from "./compose-agents-vm.ts";
import { createBoxCrashPause } from "./compose-boxes.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentEvents,
  type AgentsPort,
  createCrashPause,
  type RequestItems,
} from "./modules/agents/index.ts";
import { createRefusalSink } from "./modules/agent-vm/index.ts";

export type { AgentsVm };

/** What the VM composition adds to M11's call sites; nothing when a bed composes without it. */
export interface VmPorts {
  /** Into the one `agents` object of `setAgentPorts`: it replaces the whole object, so it cannot be set apart. */
  readonly sessions: Partial<Pick<AgentsVm, "vmLayoutOf">> & {
    /** The project boxes the sessions module reads (task A3); absent in a bed that composes without them. */
    boxes?: AgentsVm["boxes"]["sessions"];
  };
  /** Into `createAgents`: the host's resource ceilings, the check of the package picks and the VM runtime's link (T15). */
  readonly agents: {
    resourceHost?: AgentsVm["resourceHost"];
    checkPackages?: AgentsVm["checkPackages"];
    vm?: AgentsVm["agentLink"];
  };
}

const NONE: VmPorts = { sessions: {}, agents: {} };

/**
 * The VM wiring of composeM11 (`modules.vm`, absent only in a bed that composes without it). A predicate that is not wired stops
 * the boot (T8a, fail closed); and `setAgentPorts` refuses an agents object without `vmLayoutOf` once the sessions module has a launcher.
 */
export function vmPortsOf(vm: AgentsVm | undefined): VmPorts {
  if (vm === undefined) return NONE;
  for (const name of ["vmLayoutOf", "resourceHost", "checkPackages"] as const)
    if (typeof vm[name] !== "function") throw new Error(`${name} is not wired`);
  if (typeof vm.agentLink !== "object") throw new Error("agentLink is not wired");
  const { vmLayoutOf, resourceHost, checkPackages, agentLink } = vm;
  return {
    sessions: { vmLayoutOf, ...(vm.boxes ? { boxes: vm.boxes.sessions } : {}) },
    agents: { resourceHost, checkPackages, vm: agentLink },
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
    events: Pick<AgentEvents, "notify" | "write" | "update">;
    items: Pick<RequestItems, "upsertAgentItem">;
    clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  },
): void {
  vm?.bindCrashPause(createCrashPause({ ...parts, logger }));
  // The same for a project's box: one Inbox line naming the project; its Resume is the restart's (task A6).
  vm?.boxes.bindCrashPause(createBoxCrashPause({ boxes: vm.boxes, items: parts.items, logger }));
  // Sub-project 2: a host the VM proxy refused is a card in the agent's thread and an Inbox item (and its push).
  vm?.bindRefusals(
    createRefusalSink({
      clock: parts.clock,
      logger,
      ownerOf: (agentId) => parts.agents.port.ownerOf(agentId),
      events: parts.events,
      items: parts.items,
    }),
  );
}

/** The sessions' view of the agents registry: the profile of an owner's agent, null when there is none or it does not parse. */
export function sessionAgentsOf(agents: Pick<AgentsPort, "get">) {
  return (ownerId: string, agentId: string) => {
    const record = agents.get(ownerId, agentId);
    if (!record?.input) return null;
    return { input: record.input, name: record.name, quarantined: record.quarantinedAt !== null };
  };
}
