import { type Caller, PapError, ProjectId } from "@pap/contracts";
import type { Clock, TimerHandle } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import type { ClaudeTokenStore, MirrorHooks, PolicyView, RelayLink } from "./modules/agent-vm/index.ts";
import type { AgentsPort } from "./modules/agents/index.ts";
import type { PolicyPort } from "./modules/policy/index.ts";
import type { ModelsPort } from "./modules/models/index.ts";
import type { RunsPort } from "./modules/runs/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { BoxesLate } from "./compose-boxes.ts";
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

/** Where a claude-bridge agent's worker runs, and the folder it calls home (the VM layout's home, or the agent's host home). */
export interface ClaudeEnvWhere {
  readonly vm: boolean;
  readonly home: string;
}
/** An agent's Claude Code extra environment: `{}` for an agent that does not use the bridge. */
export type ClaudeEnvOf = (
  input: {
    readonly model: { readonly provider: string } | null;
    readonly packages: readonly string[] | null;
  },
  where: ClaudeEnvWhere,
) => Promise<Readonly<Record<string, string>>>;

/**
 * ADR 0080: the environment pi-claude-bridge's Claude Code CLI needs, for the agents that use the bridge only (its provider, or
 * its package among the picks; the decision of `declaresBridge`).
 * - VM: `IS_SANDBOX=1` (the CLI refuses `--dangerously-skip-permissions` as root; the VM is the sandbox) and
 *   `CLAUDE_CONFIG_DIR` in the agent's home (`HOME` is `/root`, on a read-only root).
 * - Host: `CLAUDE_CONFIG_DIR` in the agent's home only. The CLI is not sandboxed there and does not run as root, so it never
 *   gets `IS_SANDBOX`; without it, it would write the owner's real `~/.claude`.
 * Host precedence: the daemon's own `CLAUDE_CONFIG_DIR`, which reaches the worker, wins, so none is derived then. In a VM the
 * daemon's environment never reaches the worker, so that rule does not apply there.
 */
export function createClaudeEnvOf(deps: {
  readonly sourcesOf: PluginPicks["sourcesOf"];
  readonly logger: Pick<Logger, "warn">;
  readonly daemonEnv: Readonly<Record<string, string | undefined>>;
}): ClaudeEnvOf {
  return async (input, where) => {
    if (!where.vm && deps.daemonEnv.CLAUDE_CONFIG_DIR !== undefined) return {};
    if (input.model?.provider !== CLAUDE_BRIDGE_PROVIDER) {
      try {
        const sources = (await deps.sourcesOf(input.packages)) ?? [];
        if (!sources.some(isClaudeBridgeSource)) return {};
      } catch (error) {
        deps.logger.warn("claude_env_packages_unread", { err: error });
        return {};
      }
    }
    const config = { CLAUDE_CONFIG_DIR: `${where.home.replace(/\/+$/, "")}/.claude` };
    return where.vm ? { IS_SANDBOX: "1", ...config } : config;
  };
}
/** The relay holds at most 512 model pairs per agent (`RelayCommand`). */
export const POLICY_MAX_MODELS = 512;
/** Budgets reset at local midnight and a run in flight spends before it ends: every live agent is looked at again this often. */
export const POLICY_RECHECK_MS = 60_000;

/** What exists only after the sessions, the models, the agents and the runs (daemon.ts binds it once they do). */
export interface AgentsVmLate {
  readonly sessions: Pick<SessionsModule, "mirror"> & {
    kindOf(sessionId: string): { readonly agentId: string | null } | null;
    cwdOf?(ownerId: string, sessionId: string): string | null;
  };
  /** The sessions' policy: a project box session's taint taints its whole launch (spec §4). */
  readonly policy?: Pick<PolicyPort, "onSessionChange" | "sessionPolicy">;
  /** `composePi`'s result: the models Pi offers. */
  readonly pi: {
    readonly models: Pick<ModelsPort, "available" | "onChanged">;
    /** The agent form's package ids, resolved by the helper (AVM-E33). */
    readonly plugins: PluginPicks;
  };
  readonly agents: Pick<AgentsPort, "get" | "list" | "ownerOf" | "onChange">;
  /** The owner's egress host list (what an agent without a list of its own gets); absent: none. */
  ownerHosts?(ownerId: string): readonly string[] | null;
  readonly runs: { readonly port: Pick<RunsPort, "onLiveCost" | "onRunEnd"> };
  /** The automation module: the agent's own daily budget (M11R74) is `agentTasks.overBudget`. */
  readonly automation: {
    readonly agentTasks: {
      overBudget(ownerId: string, agentId: string): boolean;
      /** The owner's own daily budget, whoever spends it (a project box's sessions have no agent line). */
      ownerOverBudget(ownerId: string): boolean;
    };
  };
  /** The project boxes (spec boxes): absent, no row runs in a box and a box's connection is refused. */
  readonly boxes?: BoxesLate;
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
  /** S1: `agent_paused` for an agent quarantined since the launch passed its gate, `not_found` for one deleted. */
  agentOpen(ownerId: string, agentId: string): void;
  /** The agent's host list now: its own, else the owner's, else none. Null: the agent is unknown. */
  hostsOf(agentId: string): readonly string[] | null;
  /** A project box's relay policy: the owner's models, the bridge when the token is set, `budget` when the owner's day is spent. */
  policyOfProject(projectId: string): Promise<PolicyView>;
  /** A project box's host list now: the owner's and the project's together. Null: the project is unknown or being deleted. */
  hostsOfProject(projectId: string): readonly string[] | null;
  /** Whether the session's taint is up now (false for one the policy does not know). */
  taintedNow(ownerId: string, sessionId: string): boolean;
  /** The agent's trusted sources now; none when the agent is unknown. */
  trustedOf(agentId: string): readonly string[];
  /** Posts a notice into the agent's thread, or the sessions of the project whose id it is (the image being rebuilt, a disk that grows later); logged when it has none. */
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
    /** Where the proxy's taint of a launch's sessions goes (spec §4). */
    bindTaint(taint: (sessionId: string) => void): void;
    /** A project box's session was tainted: its launch is (spec §4). */
    launchRaised?(sessionId: string): void;
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

  ctx.bindTaint((sessionId) => late.sessions.mirror.taint(sessionId));

  const taintedNow = (ownerId: string, sessionId: string): boolean => {
    try {
      return late.policy?.sessionPolicy(ownerId, sessionId).taint.tainted === true;
    } catch {
      return false;
    }
  };
  // A project box's sessions share one launch (spec §4): whatever taints one of them taints the launch, the proxy's or not.
  late.policy?.onSessionChange((ownerId, sessionId) => {
    if (late.sessions.kindOf(sessionId)?.agentId != null) return;
    const cwd = late.sessions.cwdOf?.(ownerId, sessionId) ?? null;
    if (cwd === null || late.boxes?.source.byPath(ownerId, cwd) == null) return;
    if (taintedNow(ownerId, sessionId)) ctx.launchRaised?.(sessionId);
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
  /** The owner's offered models (the bridge apart), cached per key: a busy helper must not empty a running policy. */
  const modelsOf = async (key: string, ownerId: string) => {
    let pairs = lastModels.get(key);
    try {
      const offered = (await late.pi.models.available(ownerCaller(ownerId))).models;
      pairs = offered
        .map((model) => ({ provider: model.provider, id: model.id }))
        .filter((pair) => pair.provider !== CLAUDE_BRIDGE_PROVIDER)
        .slice(0, POLICY_MAX_MODELS);
      if (offered.length > POLICY_MAX_MODELS)
        ctx.logger.warn("relay_policy_models_cut", { agentId: key, offered: offered.length });
      lastModels.set(key, pairs);
    } catch (error) {
      if (pairs === undefined) throw error;
      ctx.logger.warn("relay_policy_models_kept", { agentId: key, err: error });
    }
    return pairs;
  };
  const derived: AgentsVmDerived = {
    sourcesOf: (ids) => late.pi.plugins.sourcesOf(ids),
    checkPackages: (ids) => late.pi.plugins.check(ids),
    async policyOf(agentId) {
      const ownerId = late.agents.ownerOf(agentId);
      if (ownerId === null) return NOTHING;
      const record = late.agents.get(ownerId, agentId);
      if (record === null) return NOTHING;
      const pairs = await modelsOf(agentId, ownerId);
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
    async policyOfProject(projectId) {
      const box = late.boxes?.source.box(projectId) ?? null;
      if (box === null || box.deleting) return NOTHING;
      return {
        models: await modelsOf(`project:${projectId}`, box.ownerId),
        claude: ctx.claudeToken.status() === "set",
        blocked: late.automation.agentTasks.ownerOverBudget(box.ownerId) ? "budget" : null,
      };
    },
    taintedNow,
    hostsOfProject(projectId) {
      const box = late.boxes?.source.box(projectId) ?? null;
      if (box === null || box.deleting) return null;
      return [...new Set([...(late.ownerHosts?.(box.ownerId) ?? []), ...box.hosts])];
    },
    hostsOf(agentId) {
      const ownerId = late.agents.ownerOf(agentId);
      const record = ownerId === null ? null : late.agents.get(ownerId, agentId);
      if (ownerId === null || record?.input == null) return null;
      return record.input.allowHosts ?? late.ownerHosts?.(ownerId) ?? [];
    },
    trustedOf(agentId) {
      const ownerId = late.agents.ownerOf(agentId);
      return (ownerId === null ? null : late.agents.get(ownerId, agentId))?.input?.trustedSources ?? [];
    },
    agentOpen(ownerId, agentId) {
      const record = late.agents.get(ownerId, agentId);
      if (record === null) throw new PapError("not_found");
      if (record.quarantinedAt !== null) throw new PapError("agent_paused");
    },
    turnsOf: (agentId) => turns.get(agentId) ?? 0,
    windowEnded: () => turns.clear(),
    notify(agentId, text) {
      // The images' notices are keyed by agent id, or by project id for a project's box (a uuid, never an agent id).
      if (ProjectId.safeParse(agentId).success) {
        if (late.boxes?.notice) late.boxes.notice(agentId, text);
        else ctx.logger.warn("agent_vm_notice_no_thread", { projectId: agentId });
        return;
      }
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
    relay.refresh({ kind: "agent", id: agentId });
  });
  // After each assistant message and compaction (the runs observer's own hook): one provider request each.
  const stopStart = late.runs.port.onLiveCost((sessionId) => {
    const agentId = agentOfSession(sessionId);
    if (agentId !== null) turns.set(agentId, (turns.get(agentId) ?? 0) + 1);
  });
  const stopEnd = late.runs.port.onRunEnd((event) => {
    const agentId = agentOfSession(event.sessionId);
    if (agentId !== null) relay.refresh({ kind: "agent", id: agentId });
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
