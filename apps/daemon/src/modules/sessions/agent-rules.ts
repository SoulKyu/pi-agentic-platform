import type { ApprovalMode, PolicyRules, VmLayout } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { AgentProfile } from "./agent-gate.ts";
import { agentHomePath } from "./agent-home.ts";
import { childModeOf } from "./child-port.ts";
import type { SessionRow } from "./store.ts";
import { vmRuleParts } from "./vm-rules.ts";

/** What the owner's settings contribute, merged with the agent's. */
export interface OwnerLists {
  readonly allowHosts: readonly string[] | null;
  readonly denylist: readonly string[];
  /** The session's own mode and whether the owner set it (`policy.setSessionMode`): it can only tighten a thread (W5-R23). */
  readonly session?: { readonly mode: ApprovalMode; readonly explicit: boolean };
}

const RANK: Readonly<Record<ApprovalMode, number>> = {
  "read-only": 0,
  supervised: 1,
  "auto-accept-edits": 2,
  "full-access": 3,
};

/**
 * W5-R23: the mode of an agent thread is the stricter of the profile's and the session's own, when the owner set one. The
 * owner can tighten a running thread at once and never loosen it past its profile. `explicit` is true only when the
 * session's mode is the stricter one, which is what the `policy` view shows.
 */
export function effectiveMode(
  profile: ApprovalMode,
  session: { readonly mode: ApprovalMode; readonly explicit: boolean },
): { mode: ApprovalMode; explicit: boolean } {
  return session.explicit && RANK[session.mode] < RANK[profile]
    ? { mode: session.mode, explicit: true }
    : { mode: profile, explicit: false };
}

export type AgentRuleParts = Partial<
  Pick<
    PolicyRules,
    | "profile"
    | "approvalMode"
    | "allowHosts"
    | "denylist"
    | "agentHome"
    | "agentScratch"
    | "sandbox"
    | "autonomy"
    | "trustedSources"
    | "hostGrants"
  >
>;

export interface AgentRulesDeps {
  readonly papHome: string;
  /** The profile in force for this session: the one its running worker started with, else the registry's now (W5-R26). */
  profileOf(ownerId: string, agentId: string, sessionId: string): AgentProfile | null;
  /** The hosts the owner allowed for this thread's session (owner a2): the daemon's own record. */
  hostGrants(sessionId: string): readonly string[];
  readonly logger: Logger;
  /** The VM layout of a row that runs in a VM (pure, the runtime's `layoutOf`); null for a host row (R15). */
  vmLayoutOf?(row: SessionRow): VmLayout | null;
}

const MAX_DENYLIST = 128;
const MAX_REMEMBERED = 256;

/**
 * The agent's part of a session's rules (M11R52), spread after the task's. A thread takes the agent's mode; a task keeps the
 * task's (M10). The agent's host list replaces the owner's when set; its patterns come after the owner's. A profile that does
 * not parse (the launch was refused before, M11R53: this is a worker already up) composes read-only rules.
 */
export function createAgentRules(deps: AgentRulesDeps) {
  const reported = new Set<string>();
  function hostRules(row: SessionRow, owner: OwnerLists): AgentRuleParts {
    const { agentId } = row;
    if (agentId === undefined) return {};
    const isTask = row.agentRole === "task";
    const isThread = row.agentRole === "thread";
    const isChild = row.agentRole === "child";
    const profile = isTask ? "isolated-task" : "agent-thread";
    const agentHome = agentHomePath(deps.papHome, agentId);
    const found = deps.profileOf(row.ownerId, agentId, row.id);
    if (found === null) {
      if (!reported.has(agentId)) {
        if (reported.size >= MAX_REMEMBERED) reported.clear();
        reported.add(agentId);
        deps.logger.warn("agent_profile_unreadable", { sessionId: row.id, agentId });
      }
      return { profile, approvalMode: "read-only", agentHome, sandbox: { required: true, network: false } };
    }
    const { input } = found;
    return {
      profile,
      // A child is held to its agent's mode, capped at `auto-accept-edits`, and keeps the lower mode its parent gave it (review I3).
      ...(isTask
        ? {}
        : {
            approvalMode: owner.session
              ? effectiveMode(isChild ? childModeOf(input.mode) : input.mode, owner.session).mode
              : isChild
                ? childModeOf(input.mode)
                : input.mode,
          }),
      allowHosts: input.allowHosts === null ? owner.allowHosts && [...owner.allowHosts] : input.allowHosts,
      denylist: [...owner.denylist, ...input.denylist].slice(0, MAX_DENYLIST),
      agentHome,
      agentScratch: isTask ? row.cwd : null,
      sandbox: { required: input.sandbox.required, network: input.sandbox.network },
      autonomy: isThread && input.trustedAutonomy ? { hosts: [...(input.allowHosts ?? [])] } : null,
      trustedSources: isTask || isThread || isChild ? [...input.trustedSources] : [],
      hostGrants: isThread ? [...deps.hostGrants(row.id)] : [],
    };
  }
  return function agentRules(row: SessionRow, owner: OwnerLists): AgentRuleParts {
    const parts = hostRules(row, owner);
    const layout = row.agentId === undefined ? null : (deps.vmLayoutOf?.(row) ?? null);
    return layout === null ? parts : vmRuleParts(parts, layout, row.agentRole === "task");
  };
}
