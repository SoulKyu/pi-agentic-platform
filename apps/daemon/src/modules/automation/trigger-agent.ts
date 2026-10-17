import { type AgentInput, bwrapArgv, type Caller, PapError, type TriggerInput } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { AgentEvents, DelegationBack, ScratchPort } from "../agents/index.ts";
import type { AgentSpend } from "../runs/index.ts";
import type { SessionsAgentPort } from "../sessions/index.ts";
import type { TriggerStore } from "./store.ts";
import { removeTriggerSecret } from "./trigger-secrets.ts";
import type { TriggerChanged } from "./triggers.ts";

/**
 * What the automation module asks of the agents registry and the agent sessions (M11): bound once at composition,
 * because the automation module is built first. Unbound, an agent trigger cannot be saved and an agent task cannot start.
 */
export interface AgentPorts {
  readonly registry: ScratchPort & {
    get(
      ownerId: string,
      agentId: string,
    ): {
      readonly name: string;
      readonly paused: boolean;
      readonly quarantinedAt: number | null;
      /** The agent's one thread, once opened (M11R59). */
      readonly threadSessionId: string | null;
      /** The profile as stored; null while it does not parse. Only the budget is read, at each gate (M11R74). */
      readonly input: { readonly budget: AgentInput["budget"] } | null;
    } | null;
    /** `not_found` for an agent that is not the owner's. */
    homeOf(ownerId: string, agentId: string): string;
  };
  readonly sessions: Pick<
    SessionsAgentPort,
    "createAgentSession" | "precheckSandbox" | "precheckEgress" | "lastText" | "taskFolders" | "threadState"
  >;
  /** The agent's thread: the one it has, or a new one (M11R59). */
  readonly threads: { open(ownerId: string, agentId: string): Promise<{ sessionId: string }> };
  /** The cards: an isolated run's (M11R69), a thread task's, written before its prompt and moved when it ends (M11R71). */
  readonly events: Pick<
    AgentEvents,
    "isolated" | "runCard" | "runCardEnded" | "reminder" | "delegation" | "delegationEnded"
  >;
  /** The result of a delegated task goes back to its requester, as a card and an Inbox item (M11R79). */
  readonly delegations: Pick<DelegationBack, "back">;
  /** The runs registry's own table, read per agent: there is no second counter (M11R74). */
  readonly spend: Pick<AgentSpend, "agentSpentToday" | "taskRuns">;
}

export interface AgentBinding {
  bind(ports: AgentPorts): void;
  ports(): AgentPorts | null;
}

export function createAgentBinding(): AgentBinding {
  let bound: AgentPorts | null = null;
  return {
    bind(ports) {
      if (bound) throw new Error("agent ports are already bound");
      bound = ports;
    },
    ports: () => bound,
  };
}

/** The columns and the config must agree on the source and the agent: a hand-edited row is unreadable, not half-trusted. */
export const agrees = (input: TriggerInput, row: { source_type: string; agent_id: string | null }): boolean =>
  input.source.type === row.source_type && input.execution.agent?.agentId === (row.agent_id ?? undefined);

/**
 * The folder and the agent a trigger is saved with (M11R66). A project trigger's folder is the owner's, resolved as ever;
 * an agent trigger's is the agent's home (the `cwd` column is NOT NULL), and the agent must be the owner's: `not_found`.
 */
export function resolveExecution(
  binding: AgentBinding | undefined,
  ownerId: string,
  execution: TriggerInput["execution"],
  folderOf: (cwd: string) => string,
): { readonly cwd: string; readonly agentId: string | null } {
  const { agent } = execution;
  if (agent === null) {
    if (execution.cwd === undefined) throw new PapError("bad_request");
    return { cwd: folderOf(execution.cwd), agentId: null };
  }
  const registry = binding?.ports()?.registry;
  if (!registry?.get(ownerId, agent.agentId)) throw new PapError("not_found");
  return { cwd: registry.homeOf(ownerId, agent.agentId), agentId: agent.agentId };
}

/**
 * W5-R31: always sandboxed, whatever the agent's `sandbox.required` says; on a host without a usable bwrap every agent
 * precheck answers `sandbox_unavailable`.
 * M11R68: the command of an agent trigger's precheck runs inside the agent's sandbox, as `[bwrap, ...argv]`. Fails closed
 * (`sandbox_unavailable` and the gate's other codes): there is no unsandboxed run to fall back to. A networked sandbox gets its
 * own proxy socket for this run (M11R243); `release` ends it and is called once the command is over, whatever came of it.
 */
export async function precheckWrapOf(
  binding: AgentBinding | undefined,
  ownerId: string,
  agentId: string,
): Promise<{ wrap: (command: string) => string[]; release: () => Promise<void>; proxied: boolean }> {
  const ports = binding?.ports();
  if (!ports) throw new PapError("sandbox_unavailable");
  const spec = await ports.sessions.precheckSandbox(ownerId, agentId);
  const held = spec.network ? await ports.sessions.precheckEgress(ownerId, agentId) : null;
  return {
    wrap: (command) => [spec.bwrap, ...bwrapArgv(spec, command, held?.socket)],
    release: async () => void (await held?.release()),
    proxied: held !== null,
  };
}

/**
 * The closed word a refused precheck is journaled with (T10): the gate's own answer, never the thrown text. An agent
 * that is quarantined (the sessions gate throws `agent_paused` only for a quarantined profile: a merely paused agent never
 * reaches it, the precheck step hands it on first), gone, or a folder that is gone say so; anything else is the spawn's generic failure.
 */
export function precheckRefusal(error: unknown): string {
  if (!(error instanceof PapError)) return "precheck spawn";
  switch (error.code) {
    case "sandbox_unavailable":
      return "sandbox_unavailable";
    case "agent_paused":
      return "quarantined";
    case "not_found":
      return "missing";
    case "invalid_cwd":
      return "invalid_cwd";
    default:
      return "precheck spawn";
  }
}

/** Ends a precheck's proxy socket; a failure is logged, never thrown into the run's outcome (M11R243). */
export async function releaseEgress(
  release: (() => Promise<void>) | undefined,
  logger: Logger,
): Promise<void> {
  try {
    await release?.();
  } catch (error) {
    logger.warn("precheck_egress_release_failed", { err: error });
  }
}

export interface AgentTriggerLinkDeps {
  readonly store: Pick<TriggerStore, "ofAgent" | "remove">;
  readonly secretsDir: string;
  /** M10's rotation, the step-up already given (quarantine, M11R115). */
  rotate(caller: Caller, triggerId: string): { readonly secret: string };
  /** The `tasks` stream hears of each removal. */
  changed(change: TriggerChanged): void;
  readonly logger: Logger;
}

/** The triggers' half of the agents registry's link (M11R66): deleting an agent deletes its triggers and their secret files. */
export function createAgentTriggerLink(deps: AgentTriggerLinkDeps) {
  return {
    /** New secrets for the agent's webhook triggers; the ones that could not be rotated are named, never skipped silently. */
    rotateSecretsOf(
      caller: Caller,
      agentId: string,
    ): {
      secrets: Array<{ triggerId: string; name: string; secret: string }>;
      failed: string[];
    } {
      const secrets: Array<{ triggerId: string; name: string; secret: string }> = [];
      const failed: string[] = [];
      for (const row of deps.store.ofAgent(caller.userId, agentId)) {
        if (row.source_type !== "webhook") continue;
        try {
          secrets.push({ triggerId: row.id, name: row.name, secret: deps.rotate(caller, row.id).secret });
        } catch (error) {
          deps.logger.warn("trigger_secret_rotate_failed", { triggerId: row.id, err: error });
          failed.push(row.id);
        }
      }
      return { secrets, failed };
    },

    deleteTriggersOf(ownerId: string, agentId: string): void {
      for (const row of deps.store.ofAgent(ownerId, agentId)) {
        deps.store.remove(ownerId, row.id);
        try {
          removeTriggerSecret(deps.secretsDir, row.id);
        } catch (error) {
          deps.logger.warn("trigger_secret_remove_failed", { err: error });
        }
        try {
          deps.changed({ ownerId, triggerId: row.id, removed: true });
        } catch (error) {
          deps.logger.warn("trigger_change_listener_failed", { err: error });
        }
      }
    },
  };
}
