import type { Caller } from "@pap/contracts";
import type { Clock, TimerHandle } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import type { ClaudeTokenStore, MirrorHooks, PolicyView, RelayLink } from "./modules/agent-vm/index.ts";
import type { AgentsPort } from "./modules/agents/index.ts";
import type { ModelsPort } from "./modules/models/index.ts";
import type { RunsPort } from "./modules/runs/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { PluginPicks } from "./plugin-picks.ts";

/** The provider id pi-claude-bridge registers (R13). */
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
/** The package that brings the bridge to an agent. */
const CLAUDE_BRIDGE_NAME = "pi-claude-bridge";
/**
 * Whether a source (as `settings.json` spells it) is the bridge package itself (AVM-E41 m6): the npm package of that name, or a
 * git or local folder whose last segment is that name. A package whose name only contains it (`pi-claude-bridge-fork`) is not.
 */
export function isClaudeBridgeSource(source: string): boolean {
  if (source.startsWith("npm:")) return source.slice(4).replace(/@[^/@]*$/, "") === CLAUDE_BRIDGE_NAME;
  const last = source.replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "";
  return last.replace(/@[^@]*$/, "").replace(/\.git$/, "") === CLAUDE_BRIDGE_NAME;
}
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
  readonly pi: {
    readonly models: Pick<ModelsPort, "available" | "onChanged">;
    /** The agent form's package ids, resolved by the helper (AVM-E33). */
    readonly plugins: PluginPicks;
  };
  readonly agents: Pick<AgentsPort, "get" | "list" | "ownerOf" | "onChange">;
  readonly runs: { readonly port: Pick<RunsPort, "onLiveCost" | "onRunEnd"> };
  /** The automation module: the agent's own daily budget (M11R74) is `agentTasks.overBudget`. */
  readonly automation: { readonly agentTasks: { overBudget(ownerId: string, agentId: string): boolean } };
}

/** What the relay link reads of the late binding. */
export interface AgentsVmDerived {
  policyOf(agentId: string): Promise<PolicyView>;
  /** The exact sources of an agent's package picks (`null`: every package); an id nothing holds is dropped. */
  sourcesOf: PluginPicks["sourcesOf"];
  /** At save: every picked id must be one the owner's Pi packages hold. */
  checkPackages: PluginPicks["check"];
  /** The turns the agent's workers reported in this relay window (RT-17): one assistant message is one provider request. */
  turnsOf(agentId: string): number;
  /** The relay reported: the next window's counts start from zero. */
  windowEnded(): void;
  /** Posts a notice into the agent's thread (the image being rebuilt, a disk that grows later); logged when it has none yet. */
  notify(agentId: string, text: string): void;
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
    notice: (sessionId, text, now) => late.sessions.mirror.notice(sessionId, text, now),
    taint: (sessionId) => late.sessions.mirror.taint(sessionId),
    canWrite: () => !ctx.readOnly,
  });

  const turns = new Map<string, number>();
  // M2: the last list of models read for an agent. A helper that is busy or slow must not empty a running agent's policy.
  const lastModels = new Map<string, Array<{ provider: string; id: string }>>();
  // AVM-E42 I2: the last bridge declaration read for an agent, like `lastModels`. It is read again only when the models list
  // refreshes (`onChanged` marks it stale), the agent changes (`agents.onChange`), the picks change, or a minute has passed (a
  // profile edit that removed the bridge raises no event the daemon sees, AVM-E45): at most one helper read per agent per minute.
  // A failed or busy read keeps the last value, and with none ever read the bridge stays off.
  const lastBridge = new Map<string, { declared: boolean; key: string; stale: boolean; at: number }>();
  late.pi.models.onChanged(() => {
    for (const known of lastBridge.values()) known.stale = true;
  });
  late.agents.onChange(({ agentId }) => {
    const known = lastBridge.get(agentId);
    if (known !== undefined) known.stale = true;
  });
  const declaresBridge = async (
    agentId: string,
    input: { model: { provider: string } | null; packages: readonly string[] | null } | null,
  ): Promise<boolean> => {
    if (input === null) return false;
    if (input.model?.provider === CLAUDE_BRIDGE_PROVIDER) return true;
    const key = JSON.stringify(input.packages);
    const known = lastBridge.get(agentId);
    if (
      known !== undefined &&
      known.key === key &&
      !known.stale &&
      clock.now() - known.at < POLICY_RECHECK_MS
    )
      return known.declared;
    try {
      const declared = ((await late.pi.plugins.sourcesOf(input.packages)) ?? []).some(isClaudeBridgeSource);
      lastBridge.set(agentId, { declared, key, stale: false, at: clock.now() });
      return declared;
    } catch (error) {
      // The models of the policy are still sent; the bridge keeps what was last known (off when nothing was).
      ctx.logger.warn("relay_policy_claude_kept", { agentId, err: error });
      return known?.declared ?? false;
    }
  };
  const derived: AgentsVmDerived = {
    sourcesOf: (ids) => late.pi.plugins.sourcesOf(ids),
    checkPackages: (ids) => late.pi.plugins.check(ids),
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
        claude: ctx.claudeToken.status() === "set" && (await declaresBridge(agentId, record.input)),
        blocked: record.paused
          ? "paused"
          : late.automation.agentTasks.overBudget(ownerId, agentId)
            ? "budget"
            : null,
      };
    },
    turnsOf: (agentId) => turns.get(agentId) ?? 0,
    windowEnded: () => turns.clear(),
    notify(agentId, text) {
      const ownerId = late.agents.ownerOf(agentId);
      const sessionId =
        ownerId === null ? null : (late.agents.get(ownerId, agentId)?.threadSessionId ?? null);
      if (sessionId === null) ctx.logger.warn("agent_vm_notice_no_thread", { agentId });
      else late.sessions.mirror.notice(sessionId, text);
    },
  };
  if (relay === null) return derived;

  const agentOfSession = (sessionId: string): string | null =>
    late.sessions.kindOf(sessionId)?.agentId ?? null;
  // The triggers of a policy push: the models cache is cleared (ADR 0068), a pause or an edit, a run that began or ended
  // (the budget moves), and a timer for the midnight reset.
  late.pi.models.onChanged(() => relay.refreshAll());
  late.agents.onChange(({ agentId, removed }) => {
    if (removed) {
      lastModels.delete(agentId);
      lastBridge.delete(agentId);
    }
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
