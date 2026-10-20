import type { spawn } from "node:child_process";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Db } from "./kernel/db/database.ts";
import type { MigrationSource } from "./kernel/db/migrate.ts";
import type { GitRunner } from "./kernel/git/runner.ts";
import type { Logger } from "./kernel/logger.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import { bootAgentEgress, bootSandboxProbe } from "./compose-m11-probe.ts";
import { type AgentsVm, bindVmCrash, sessionAgentsOf, vmPortsOf } from "./compose-m11-vm.ts";
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
  createInboxLink,
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
import type { EgressPort } from "./modules/egress/index.ts";
import { composeSubagents, type M11RunsPort } from "./compose-subagents.ts";
import { requireStepUp } from "./modules/auth/index.ts";
import type { AutomationModule } from "./modules/automation/index.ts";
import { createMemoryModule, type MemoryRpc } from "./modules/memory/index.ts";
import type { Inbox } from "./modules/inbox/index.ts";
import { createPlatformPort, type PlatformHandler, type PlatformPort } from "./modules/platform/index.ts";
import { createAgentSpend } from "./modules/runs/index.ts";
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
import { SUBAGENTS_MIGRATIONS, type SubagentsPorts, type SubagentsRpc } from "./modules/subagents/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";

/** The migration sources of M11's new modules. The session kinds migration is the sessions module's own. */
export const M11_MIGRATION_SOURCES: readonly MigrationSource[] = [AGENTS_MIGRATIONS, SUBAGENTS_MIGRATIONS];

/** What `composeM11` reads of the daemon's core. */
export interface M11Core {
  readonly db: Db;
  readonly config: Pick<Config, "home" | "bwrapOverride" | "piAgentDir"> & Partial<Pick<Config, "userHome">>;
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
    | "child"
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
  readonly runs: M11RunsPort;
  /** The lanes module's folder paths: whose lane worktree a folder is in. */
  readonly lanes: {
    readonly paths: { laneOf(cwd: string): { readonly ownerId: string } | null };
    readonly note: PlatformHandler<"lane.note">;
  };
  /** M10's automation module, built before this entry: an agent's triggers and tasks (Task 10). */
  readonly automationModule: Pick<AutomationModule, "agentLink" | "bindAgents" | "agentTasks">;
  /** M10's Inbox: the delegation result's reply item, the reply a reset closes, the items a delete drops (M11R79, M11R91). */
  readonly inbox: {
    readonly agentItems: Pick<
      Inbox["agentItems"],
      "upsertAgentItem" | "resolveRef" | "removeAgentItems" | "openRefs"
    >;
  };
  readonly subagents: SubagentsPorts;
  readonly vm?: AgentsVm | undefined;
  /** Tests only: replaces the egress proxy. The daemon never passes one: production builds the real proxy (M11R244). */
  readonly egress?: EgressPort;
  /** The owner's automation time zone: the day an agent's budget and figures count in (M11R74, M11R76). */
  readonly settings: { readonly port: Pick<SettingsModule["port"], "automation" | "agents"> };
}

export interface M11 {
  readonly platform: PlatformPort;
  /** The agents registry other M11 modules read (M11R43). */
  readonly agents: AgentsPort;
  /** M11's RPC methods; each task adds its table here, never in `daemon.ts`. */
  readonly rpc: AgentsRpc & SecretsRpc & SecretRequestsRpc & SubagentsRpc & MemoryRpc;
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
  const sandboxProbe = bootSandboxProbe(core);
  const agentsLogger = core.logger.child({ module: "agents" });
  const vm = vmPortsOf(modules.vm);
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
    ...vm.agents,
  });
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
  const egress: EgressPort = modules.egress ?? bootAgentEgress(core);
  modules.sessions.setAgentPorts({
    agents: {
      profileOf: sessionAgentsOf(agents.port),
      vaultOf: secrets.vaultOf,
      onceOf: once.forSession,
      onceUsed: (sessionId, id) => void once.used(sessionId, id),
      probe: sandboxProbe,
      egress,
      ownerHosts: (ownerId) => modules.policy?.port.settings(ownerId).allowHosts ?? null,
      ...(core.config.userHome === undefined ? {} : { homeDir: () => core.config.userHome as string }),
      ...vm.sessions,
    },
  });
  agents.setLinks({
    vault: secrets,
    onceValues: { drop: (_ownerId, agentId) => void once.dropAgent(agentId) },
  });
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
  bindVmCrash(modules.vm, agentsLogger, { agents, events, items });
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
  // Subagents (Task 29b): the op is on the platform port with the owner's switch (M11R36, M11R137).
  const subagents = composeSubagents(core, modules, platform, {
    budgetOf: (ownerId, agentId) => agents.port.get(ownerId, agentId)?.input?.budget ?? null,
    spend,
  });
  agents.setLinks({
    automation: modules.automationModule.agentLink,
    // The rail's red dot (M11R62), and quarantine's step 2 for the agent's children (M11R139).
    rail: { failedCard: events.failedCard, childWaiting: subagents.childWaiting },
    subagents: { cancelAllOf: subagents.cancelAgent },
    inbox: createInboxLink(items, agentsLogger),
  });
  const memory = createMemoryModule({ core, audit: modules.audit, inbox: modules.inbox, agents });
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
          ...vm.safety,
        }),
      ),
      ...secretsRpc(secrets),
      ...secretRequestsRpc(secretRequests),
      ...subagents.rpc,
      ...memory.rpc,
    },
    stop() {
      platform.stop();
      subagents.stop();
      memory.stop();
      stopRegistry();
      stream.stop();
      unread.stop();
      threadLink.stop();
    },
  };
}
