import type { Caller } from "@pap/contracts";
import type { Clock, TimerHandle } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import type { ClaudeTokenStore, MirrorHooks, PolicyView, RelayLink } from "./modules/agent-vm/index.ts";
import type { AgentsPort } from "./modules/agents/index.ts";
import type { ModelsPort } from "./modules/models/index.ts";
import type { RunsPort } from "./modules/runs/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";

/** The provider id pi-claude-bridge registers (R13). */
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
/** The package that brings the bridge to an agent (its sources are `npm:pi-claude-bridge`, a git URL, a path...). */
const CLAUDE_BRIDGE_PACKAGE = /pi-claude-bridge/;
/** The relay holds at most 512 model pairs per agent (`RelayCommand`). */
export const POLICY_MAX_MODELS = 512;
/** Budgets reset at local midnight and a run in flight spends before it ends: every live agent is looked at again this often. */
export const POLICY_RECHECK_MS = 60_000;

/** What exists only after the sessions, the models, the agents and the runs (daemon.ts binds it once they do). */
export interface AgentsVmLate {
  readonly sessions: Pick<SessionsModule, "mirror"> & {
    kindOf(sessionId: string): { readonly agentId: string | null } | null;
  };
  /** `composePi`'s result: the models Pi offers. */
  readonly pi: { readonly models: Pick<ModelsPort, "available" | "onChanged"> };
  readonly agents: Pick<AgentsPort, "get" | "ownerOf" | "onChange">;
  readonly runs: { readonly port: Pick<RunsPort, "onLiveCost" | "onRunEnd"> };
  /** The automation module: the agent's own daily budget (M11R74) is `agentTasks.overBudget`. */
  readonly automation: { readonly agentTasks: { overBudget(ownerId: string, agentId: string): boolean } };
}

/** What the relay link reads of the late binding. */
export interface AgentsVmDerived {
  policyOf(agentId: string): Promise<PolicyView>;
  /** The turns the agent's workers reported in this relay window (RT-17): one assistant message is one provider request. */
  turnsOf(agentId: string): number;
  /** The relay reported: the next window's counts start from zero. */
  windowEnded(): void;
}

const NOTHING: PolicyView = { models: [], claude: false, blocked: null };

/** The listing is read for the agent's owner; the helper only needs a user id (no cwd is named). */
const ownerCaller = (userId: string): Caller => ({
  userId,
  permissions: new Set(),
  kind: "session",
  credentialId: "agents-vm",
  stepUpUntil: 0,
});

export function bindAgentsVmLate(
  ctx: {
    readonly clock: Clock;
    readonly logger: Logger;
    readonly closers: Array<{ readonly name: string; close(): void | Promise<void> }>;
    readonly relay: RelayLink | null;
    /** The bridge's `claude` policy needs the owner's token to be set. */
    readonly claudeToken: Pick<ClaudeTokenStore, "status">;
    readonly readOnly: boolean;
    bindMirrorHooks(hooks: MirrorHooks): void;
  },
  late: AgentsVmLate,
): AgentsVmDerived {
  const { clock, relay } = ctx;
  // AVM-E21: a replacement of the VM's transcript posts the notice and taints through the sessions' own paths.
  ctx.bindMirrorHooks({
    notice: (sessionId, text) => late.sessions.mirror.notice(sessionId, text),
    taint: (sessionId) => late.sessions.mirror.taint(sessionId),
    canWrite: () => !ctx.readOnly,
  });

  const turns = new Map<string, number>();
  // M2: the last list of models read for an agent. A helper that is busy or slow must not empty a running agent's policy.
  const lastModels = new Map<string, Array<{ provider: string; id: string }>>();
  const declaresBridge = (
    input: { model: { provider: string } | null; packages: readonly string[] | null } | null,
  ) =>
    input !== null &&
    (input.model?.provider === CLAUDE_BRIDGE_PROVIDER ||
      (input.packages ?? []).some((source) => CLAUDE_BRIDGE_PACKAGE.test(source)));
  const derived: AgentsVmDerived = {
    async policyOf(agentId) {
      const ownerId = late.agents.ownerOf(agentId);
      if (ownerId === null) return NOTHING;
      const record = late.agents.get(ownerId, agentId);
      if (record === null) return NOTHING;
      let pairs = lastModels.get(agentId);
      try {
        const offered = (await late.pi.models.available(ownerCaller(ownerId))).models;
        pairs = offered
          .map((model) => ({ provider: model.provider, id: model.id }))
          .filter((pair) => pair.provider !== CLAUDE_BRIDGE_PROVIDER)
          .slice(0, POLICY_MAX_MODELS);
        if (offered.length > POLICY_MAX_MODELS)
          ctx.logger.warn("relay_policy_models_cut", { agentId, offered: offered.length });
        lastModels.set(agentId, pairs);
      } catch (error) {
        if (pairs === undefined) throw error;
        ctx.logger.warn("relay_policy_models_kept", { agentId, err: error });
      }
      return {
        models: pairs,
        // `models.available` loads no extension, so it never lists the bridge: the profile says whether the agent has it.
        claude: ctx.claudeToken.status() === "set" && declaresBridge(record.input),
        blocked: record.paused
          ? "paused"
          : late.automation.agentTasks.overBudget(ownerId, agentId)
            ? "budget"
            : null,
      };
    },
    turnsOf: (agentId) => turns.get(agentId) ?? 0,
    windowEnded: () => turns.clear(),
  };
  if (relay === null) return derived;

  const agentOfSession = (sessionId: string): string | null =>
    late.sessions.kindOf(sessionId)?.agentId ?? null;
  // The triggers of a policy push: the models cache is cleared (ADR 0068), a pause or an edit, a run that began or ended
  // (the budget moves), and a timer for the midnight reset.
  late.pi.models.onChanged(() => relay.refreshAll());
  late.agents.onChange(({ agentId, removed }) => {
    if (removed) lastModels.delete(agentId);
    relay.refresh(agentId);
  });
  // After each assistant message and compaction (the runs observer's own hook): one provider request each.
  const stopStart = late.runs.port.onLiveCost((sessionId) => {
    const agentId = agentOfSession(sessionId);
    if (agentId !== null) turns.set(agentId, (turns.get(agentId) ?? 0) + 1);
  });
  const stopEnd = late.runs.port.onRunEnd((event) => {
    const agentId = agentOfSession(event.sessionId);
    if (agentId !== null) relay.refresh(agentId);
  });
  let timer: TimerHandle | undefined;
  let closed = false;
  const tick = (): void => {
    if (closed) return;
    relay.refreshAll();
    timer = clock.setTimeout(tick, POLICY_RECHECK_MS);
  };
  timer = clock.setTimeout(tick, POLICY_RECHECK_MS);
  ctx.closers.push({
    name: "agent_relay_policy",
    close: () => {
      closed = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      stopStart();
      stopEnd();
    },
  });
  return derived;
}
