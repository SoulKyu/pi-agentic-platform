import type { MigrationSource } from "./kernel/db/migrate.ts";
import type { M11, M11Core, M11Modules } from "./compose-m11-types.ts";
import { bindVmCrash, sessionAgentsOf, vmPortsOf } from "./compose-m11-vm.ts";
import {
  AGENTS_MIGRATIONS,
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
  createThreadLink,
  createThreads,
  createUnread,
} from "./modules/agents/index.ts";
import { composeSubagents } from "./compose-subagents.ts";
import { requireStepUp } from "./modules/auth/index.ts";
import { createMemoryModule } from "./modules/memory/index.ts";
import { createPlatformPort } from "./modules/platform/index.ts";
import { createAgentSpend } from "./modules/runs/index.ts";
import {
  createOnceStore,
  createSecretRequests,
  createSecrets,
  createVaultStore,
  loadRefSalt,
  secretRequestsRpc,
  secretsRpc,
  vaultRootOf,
} from "./modules/secrets/index.ts";
import { SUBAGENTS_MIGRATIONS } from "./modules/subagents/index.ts";

/** A composition without the file store (tests): no imported prompts. */
const NO_AGENT_FILES = { list: () => [], readOne: async () => null };

/** The migration sources of M11's new modules. The session kinds migration is the sessions module's own. */
export const M11_MIGRATION_SOURCES: readonly MigrationSource[] = [AGENTS_MIGRATIONS, SUBAGENTS_MIGRATIONS];

export type { M11, M11Core, M11Modules } from "./compose-m11-types.ts";

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
  const once = createOnceStore(() => core.clock.now());
  modules.sessions.setAgentPorts({
    agents: {
      profileOf: sessionAgentsOf(agents.port),
      vaultOf: secrets.vaultOf,
      onceOf: once.forSession,
      onceUsed: (sessionId, id) => void once.used(sessionId, id),
      ...(modules.claudeEnvOf ? { claudeEnvOf: modules.claudeEnvOf } : {}),
      ...vm.sessions,
    },
  });
  agents.setLinks({
    vault: secrets,
    onceValues: { drop: (_ownerId, agentId) => void once.dropAgent(agentId) },
    files: core.agentFilesLink,
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
  bindVmCrash(modules.vm, agentsLogger, { agents, events, items, clock: core.clock });
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
    vmLate: {
      agents: agents.port,
      ownerHosts: (ownerId: string) => modules.policy?.port.settings(ownerId).allowHosts ?? null,
    },
    rpc: {
      ...agentsRpc(
        agents,
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
          ownerSettings: (ownerId) => modules.policy?.port.settings(ownerId),
          liveTools: modules.sessions.agentSessions.activeTools,
          hostGrants: (sessionId) => modules.sessions.hostGrants.of(sessionId),
          files: core.agentFiles ?? NO_AGENT_FILES,
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
