import type { spawn } from "node:child_process";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Db } from "./kernel/db/database.ts";
import type { MigrationSource } from "./kernel/db/migrate.ts";
import type { GitRunner } from "./kernel/git/runner.ts";
import type { Logger } from "./kernel/logger.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import { createSandboxProbe, removeStaleProbes } from "./kernel/sandbox/probe.ts";
import {
  AGENTS_MIGRATIONS,
  type AgentsRpc,
  agentsRpc,
  createAgentEvents,
  createAgentGuard,
  createAgentReads,
  createAgentSafety,
  createAgents,
  createApprove,
  createNetworkRequest,
  createNotify,
  createRequests,
  createAgentsStream,
  createDelegate,
  createDelegationBack,
  createRemind,
  createQueueTask,
  createRequestViews,
  createSandboxMethods,
  createThreadLink,
  createThreads,
  createUnread,
  type AgentsPort,
} from "./modules/agents/index.ts";
import type { AuditPort } from "./modules/audit/index.ts";
import { bootEgress, type EgressPort } from "./modules/egress/index.ts";
import { requireStepUp } from "./modules/auth/index.ts";
import type { AutomationModule } from "./modules/automation/index.ts";
import type { Inbox } from "./modules/inbox/index.ts";
import { createPlatformPort, type PlatformHandler, type PlatformPort } from "./modules/platform/index.ts";
import { createAgentSpend, type RunsPort } from "./modules/runs/index.ts";
import {
  createOnceStore,
  createSecretRequests,
  createSecrets,
  createVaultStore,
  loadRefSalt,
  type SecretRequestsRpc,
  secretRequestsRpc,
  type SecretsRpc,
  secretsRpc,
  vaultRootOf,
} from "./modules/secrets/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";

/** The migration sources of M11's new modules. The session kinds migration is the sessions module's own. */
export const M11_MIGRATION_SOURCES: readonly MigrationSource[] = [AGENTS_MIGRATIONS];

/** What `composeM11` reads of the daemon's core. */
export interface M11Core {
  readonly db: Db;
  readonly config: Pick<Config, "home" | "bwrapOverride"> & Partial<Pick<Config, "userHome">>;
  /** The daemon's environment: the egress proxy's sockets live under `$XDG_RUNTIME_DIR` when it is private (W5-R42). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  readonly hub: Pick<StreamHub, "publish" | "registerSnapshot">;
  /** Tests only: the process spawn of the sandbox probe. */
  readonly probeSpawn?: typeof spawn | undefined;
}

/** The modules `composeM11` is given once they exist; later tasks add the ones they need. */
export interface M11Modules {
  readonly sessions: Pick<
    SessionsModule,
    | "kindOf"
    | "approvedCalls"
    | "setAgentPorts"
    | "releaseIdle"
    | "automation"
    | "agentSessions"
    | "hostGrants"
  >;
  /** The owner's settings: their host list is what an agent's own list is judged against (W5-R36). */
  readonly policy?: {
    readonly port: {
      settings(ownerId: string): {
        readonly allowHosts: readonly string[] | null;
        readonly denylist: readonly unknown[];
      };
    };
  };
  /** The kernel git runner: the only way pap runs git, here to make an agent's home (M11R46). */
  readonly git: GitRunner;
  readonly audit: { readonly port: Pick<AuditPort, "append" | "reserve"> };
  /** The run registry's port: a thread's run start and end move the rail and the unread count. */
  readonly runs: Pick<RunsPort, "onRunStart" | "onRunEnd">;
  /** The lanes module's folder paths: whose lane worktree a folder is in. */
  readonly lanes: {
    readonly paths: { laneOf(cwd: string): { readonly ownerId: string } | null };
    readonly note: PlatformHandler<"lane.note">;
  };
  /** M10's automation module, built before this entry: an agent's triggers and tasks (Task 10). */
  readonly automationModule: Pick<AutomationModule, "agentLink" | "bindAgents" | "agentTasks">;
  /** M10's Inbox: the delegation result's reply item, the reply a reset closes, the items a delete drops (M11R79, M11R91). */
  readonly inbox: {
    readonly agentItems: Pick<Inbox["agentItems"], "upsertAgentItem" | "resolveRef" | "removeAgentItems">;
  };
  /** Tests only: replaces the egress proxy. The daemon never passes one: production builds the real proxy (M11R244). */
  readonly egress?: EgressPort;
  /** The owner's automation time zone: the day an agent's budget and figures count in (M11R74, M11R76). */
  readonly settings: { readonly port: Pick<SettingsModule["port"], "automation"> };
}

export interface M11 {
  readonly platform: PlatformPort;
  /** The agents registry other M11 modules read (M11R43). */
  readonly agents: AgentsPort;
  /** M11's RPC methods; each task adds its table here, never in `daemon.ts`. */
  readonly rpc: AgentsRpc & SecretsRpc & SecretRequestsRpc;
  /** First in the daemon's stop: the dispatcher answers `unavailable` before the sessions' workers are stopped. */
  stop(): void;
}

/** The daemon's only M11 entry (M11R42): builds the platform dispatcher and hands it to the sessions module, before the server listens. */
export function composeM11(core: M11Core, modules: M11Modules): M11 {
  const platform = createPlatformPort({
    sessions: modules.sessions,
    audit: modules.audit.port,
    clock: core.clock,
    logger: core.logger,
    readOnly: core.readOnly,
  });
  modules.sessions.setAgentPorts({
    platform,
    inLane: (ownerId, cwd) => modules.lanes.paths.laneOf(cwd)?.ownerId === ownerId,
  });
  // The probe runs in the background: a slow or failing bwrap never delays the boot (cross-plan agreement 10, M11R57).
  const sandboxProbe = createSandboxProbe({
    override: core.config.bwrapOverride,
    clock: core.clock,
    logger: core.logger,
    // The canary folder lives in $PAP_HOME, a folder of the read-only root (W5 carry 5).
    tmp: core.config.home,
    ...(core.probeSpawn ? { spawn: core.probeSpawn } : {}),
  });
  removeStaleProbes(core.config.home, core.logger);
  void sandboxProbe.recheck();
  const agentsLogger = core.logger.child({ module: "agents" });
  const guard = createAgentGuard();
  platform.register("lane.note", modules.lanes.note);
  const agents = createAgents({
    db: core.db,
    clock: core.clock,
    logger: agentsLogger,
    guard,
    audit: modules.audit.port,
    git: modules.git,
    papHome: core.config.home,
    requireStepUp,
    ownerHosts: (ownerId) => modules.policy?.port.settings(ownerId).allowHosts,
  });
  const sessionAgents = (ownerId: string, agentId: string) => {
    const record = agents.port.get(ownerId, agentId);
    if (!record?.input) return null;
    return { input: record.input, name: record.name, quarantined: record.quarantinedAt !== null };
  };
  // The agents' secrets (Task 13): sealed under $PAP_HOME/secrets/vault, decrypted for a worker with the sandbox on only.
  const secrets = createSecrets({
    vault: createVaultStore(vaultRootOf(core.config.home)),
    agents: agents.port,
    audit: modules.audit.port,
    sessions: modules.sessions.agentSessions,
    clock: core.clock,
    logger: core.logger.child({ module: "secrets" }),
    readOnly: core.readOnly,
  });
  // The egress proxy (M11R243) boots before any worker can start: the agents port that lets a launch through is bound below,
  // and the launch gate waits for the proxy's `ready()`.
  const once = createOnceStore(() => core.clock.now());
  const egress: EgressPort =
    modules.egress ??
    bootEgress({
      clock: core.clock,
      logger: core.logger.child({ module: "egress" }),
      papHome: core.config.home,
      runtimeDir: core.env?.["XDG_RUNTIME_DIR"],
    });
  modules.sessions.setAgentPorts({
    agents: {
      profileOf: sessionAgents,
      vaultOf: secrets.vaultOf,
      onceOf: once.forSession,
      onceUsed: (sessionId, id) => void once.used(sessionId, id),
      probe: sandboxProbe,
      egress,
      ownerHosts: (ownerId) => modules.policy?.port.settings(ownerId).allowHosts ?? null,
      ...(core.config.userHome === undefined ? {} : { homeDir: () => core.config.userHome as string }),
    },
  });
  agents.setLinks({ vault: secrets });
  agents.setLinks({ onceValues: { drop: (_ownerId, agentId) => void once.dropAgent(agentId) } });
  const { automation } = modules.sessions;
  const threadLink = createThreadLink({
    automation,
    agentSessions: modules.sessions.agentSessions,
    releaseIdle: modules.sessions.releaseIdle,
    runs: modules.runs,
    clock: core.clock,
    logger: agentsLogger,
  });
  agents.setLinks({ threads: threadLink.link });
  const requests = createRequestViews(core.db);
  const stream = createAgentsStream({
    store: agents.store,
    requests,
    clock: core.clock,
    logger: agentsLogger,
    hub: core.hub,
    sessions: modules.sessions.agentSessions,
    lastActivityAt: automation.lastActivityAt,
    runs: modules.runs,
    onAttention: (listener) => automation.onAttention((sessionId) => listener(sessionId)),
    links: agents.links,
  });
  agents.setRail(stream);
  const stopRegistry = agents.port.onChange((change) => stream.registryChanged(change));
  const unread = createUnread({
    store: agents.store,
    clock: core.clock,
    runs: modules.runs,
    changed: stream.touch,
    reply: {
      raise: (ownerId, agentId) =>
        void modules.inbox.agentItems.upsertAgentItem({
          ownerId,
          kind: "agent_reply",
          agentId,
          refId: agentId,
          toHandle: false,
        }),
      clear: (ownerId, agentId) =>
        void modules.inbox.agentItems.resolveRef(ownerId, "agent_reply", agentId, null),
    },
    logger: agentsLogger,
  });
  const threads = createThreads({
    store: agents.store,
    sessions: modules.sessions.agentSessions,
    guard,
    clock: core.clock,
    logger: agentsLogger,
    links: agents.links,
    changed: stream.touch,
    audit: modules.audit.port,
  });
  // The cards (M11R72): each write counts unread and tells the open agent tab. The spend is the runs registry's own table.
  const events = createAgentEvents({
    db: core.db,
    clock: core.clock,
    logger: agentsLogger,
    unread,
    written: stream.eventWritten,
  });
  const spend = createAgentSpend({ db: core.db, clock: core.clock });
  const items = modules.inbox.agentItems;
  const delegations = createDelegationBack({
    agents: agents.port,
    events,
    inbox: items,
    logger: agentsLogger,
  });
  // The agents' triggers and tasks (Task 10, Task 11): delete asks them, a thread task opens the thread and writes its card.
  modules.automationModule.bindAgents({
    registry: agents.port,
    sessions: modules.sessions.agentSessions,
    threads,
    events,
    delegations,
    spend,
  });
  // Notifications and approval requests (Task 17): the owner answers a request through agents.answerApproval.
  const agentRequests = createRequests({
    db: core.db,
    clock: core.clock,
    logger: agentsLogger,
    items: items,
    audit: modules.audit.port,
    changed: stream.requestChanged,
    readOnly: core.readOnly,
  });
  agents.setLinks({ requests: agentRequests });
  platform.register(
    "agent.notify",
    createNotify({ events, items: items, clock: core.clock, logger: agentsLogger }),
  );
  platform.register(
    "agent.approve",
    createApprove({ requests: agentRequests, clock: core.clock, logger: agentsLogger }),
  );
  platform.register(
    "network.request",
    createNetworkRequest({ grants: modules.sessions.hostGrants, clock: core.clock }),
  );
  // secret.request (Task 18): the salt of the refs is made when the first one is, never at boot.
  let refSalt: Buffer | null = null;
  const secretRequests = createSecretRequests({
    requests: agentRequests,
    secrets,
    once,
    salt: () => (refSalt ??= loadRefSalt(vaultRootOf(core.config.home))),
    sessions: modules.sessions.agentSessions,
    probe: sandboxProbe,
    clock: core.clock,
    audit: modules.audit.port,
    logger: core.logger.child({ module: "secrets" }),
    readOnly: core.readOnly,
  });
  platform.register("secret.request", secretRequests.op);
  // Delegation and reminders (Task 12): the dispatcher's tainted-ask rule already stands before these run (M11R82).
  const tasks = modules.automationModule.agentTasks;
  platform.register("agent.delegate", createDelegate({ clock: core.clock, agents: agents.port, tasks }));
  platform.register(
    "agent.remind",
    createRemind({
      clock: core.clock,
      agents: agents.port,
      tasks,
      settings: { automation: (ownerId) => modules.settings.port.automation(ownerId) },
    }),
  );
  agents.setLinks({
    inbox: {
      clearReply: (ownerId, agentId) => void items.resolveRef(ownerId, "agent_reply", agentId, null),
      removeAgentItems(ownerId, agentId) {
        try {
          items.removeAgentItems(ownerId, agentId);
        } catch (error) {
          agentsLogger.warn("agent_items_remove_failed", { err: error });
        }
      },
    },
  });
  agents.setLinks({
    automation: modules.automationModule.agentLink,
    // The rail's red dot (M11R62); Task 30 replaces the children's half.
    rail: { failedCard: events.failedCard, childWaiting: () => false },
  });
  return {
    platform,
    agents: agents.port,
    rpc: {
      ...agentsRpc(
        agents,
        createSandboxMethods(sandboxProbe, core.clock, egress),
        threads,
        unread,
        createAgentReads({
          store: agents.store,
          events,
          spend,
          timeZone: (ownerId) => modules.settings.port.automation(ownerId).timezone,
          links: agents.links,
        }),
        createQueueTask({ store: agents.store, links: agents.links }),
        agentRequests,
        createAgentSafety({
          store: agents.store,
          links: agents.links,
          lock: threads.locked,
          guard,
          clock: core.clock,
          logger: agentsLogger,
          audit: modules.audit.port,
          requireStepUp,
          changed: stream.touch,
          papHome: core.config.home,
          sandboxUsable: () => sandboxProbe.current().usable,
          ownerSettings: (ownerId) => modules.policy?.port.settings(ownerId),
          liveTools: modules.sessions.agentSessions.activeTools,
          hostGrants: (sessionId) => modules.sessions.hostGrants.of(sessionId),
        }),
      ),
      ...secretsRpc(secrets),
      ...secretRequestsRpc(secretRequests),
    },
    stop() {
      platform.stop();
      stopRegistry();
      stream.stop();
      unread.stop();
      threadLink.stop();
    },
  };
}
