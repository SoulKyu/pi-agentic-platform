import type { Caller } from "@pap/contracts";
import type { Clock, TimerHandle } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import type { MirrorHooks, PolicyView, RelayLink } from "./modules/agent-vm/index.ts";
import type { AgentsPort } from "./modules/agents/index.ts";
import type { ModelsPort } from "./modules/models/index.ts";
import type { RunsPort } from "./modules/runs/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";

/** The provider id pi-claude-bridge registers: its models make an agent's `claude` policy true (R13). */
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
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
  readonly runs: { readonly port: Pick<RunsPort, "onRunStart" | "onRunEnd"> };
  /** The automation module: the agent's own daily budget (M11R74) is `agentTasks.overBudget`. */
  readonly automation: { readonly agentTasks: { overBudget(ownerId: string, agentId: string): boolean } };
}

/** What the relay link reads of the late binding. */
export interface AgentsVmDerived {
  policyOf(agentId: string): Promise<PolicyView>;
  /** The runs the agent's workers started since the last call (reset): the attribution check of RT-17. */
  takeRuns(agentId: string): number;
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

  const runs = new Map<string, number>();
  const derived: AgentsVmDerived = {
    async policyOf(agentId) {
      const ownerId = late.agents.ownerOf(agentId);
      if (ownerId === null) return NOTHING;
      const record = late.agents.get(ownerId, agentId);
      if (record === null) return NOTHING;
      const offered = (await late.pi.models.available(ownerCaller(ownerId))).models;
      const pairs = offered.map((model) => ({ provider: model.provider, id: model.id }));
      if (pairs.length > POLICY_MAX_MODELS)
        ctx.logger.warn("relay_policy_models_cut", { agentId, offered: pairs.length });
      return {
        models: pairs.filter((pair) => pair.provider !== CLAUDE_BRIDGE_PROVIDER).slice(0, POLICY_MAX_MODELS),
        claude: pairs.some((pair) => pair.provider === CLAUDE_BRIDGE_PROVIDER),
        blocked: record.paused
          ? "paused"
          : late.automation.agentTasks.overBudget(ownerId, agentId)
            ? "budget"
            : null,
      };
    },
    takeRuns(agentId) {
      const count = runs.get(agentId) ?? 0;
      runs.delete(agentId);
      return count;
    },
  };
  if (relay === null) return derived;

  const agentOfSession = (sessionId: string): string | null =>
    late.sessions.kindOf(sessionId)?.agentId ?? null;
  // The triggers of a policy push: the models cache is cleared (ADR 0068), a pause or an edit, a run that began or ended
  // (the budget moves), and a timer for the midnight reset.
  late.pi.models.onChanged(() => relay.refreshAll());
  late.agents.onChange(({ agentId }) => relay.refresh(agentId));
  const stopStart = late.runs.port.onRunStart((event) => {
    const agentId = agentOfSession(event.sessionId);
    if (agentId !== null) runs.set(agentId, (runs.get(agentId) ?? 0) + 1);
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
