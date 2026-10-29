import { join } from "node:path";
import type { HandlerTable } from "@pap/contracts";
import { createClaudeEnvOf } from "./compose-agents-vm-late.ts";
import { composeAgentsVmRpc } from "./compose-agents-vm-rpc.ts";
import { composeAgentsVm } from "./compose-agents-vm.ts";
import { composeAuth } from "./compose-auth.ts";
import { composeBoxWiring } from "./compose-boxes-wiring.ts";
import { createWorkspaceModules } from "./compose-workspace.ts";
import { createWsProbe } from "./compose-ws-probe.ts";
import { composeFonts } from "./compose-fonts.ts";
import { composeGithub, createGithubCore } from "./compose-github.ts";
import { composeLanes, LANE_MIGRATIONS } from "./compose-lanes.ts";
import { composeM10, composeM10Early, M10_MIGRATION_SOURCES } from "./compose-m10.ts";
import { composeM11, M11_MIGRATION_SOURCES } from "./compose-m11.ts";
import { composePi } from "./compose-pi.ts";
import { settingsMembersOf } from "./compose-boxes-budget.ts";
import { composeUsers, USERS_MIGRATION_SOURCES } from "./compose-users.ts";
import { composePreviews } from "./compose-previews.ts";
import { previewsLate } from "./compose-previews-late.ts";
import { composePush, PUSH_MIGRATIONS } from "./compose-push.ts";
import { announceStart } from "./daemon-announce.ts";
import type { DaemonDeps, DaemonHandle } from "./daemon-types.ts";
import { createSystemClock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import { ensureInstallTimestamp } from "./kernel/db/meta.ts";
import { KERNEL_MIGRATIONS, migrate } from "./kernel/db/migrate.ts";
import { createReceiptStore, startReceiptPurge } from "./kernel/db/receipts.ts";
import { acquireInstanceLock, prepareHome } from "./kernel/home.ts";
import { createHttpApp } from "./kernel/http/app.ts";
import { createFetchSiteRefusalLog } from "./kernel/http/fetch-site-refusals.ts";
import { createOriginRefusalLog } from "./kernel/http/origin-refusals.ts";
import { startServer } from "./kernel/http/server.ts";
import { newId } from "./kernel/ids.ts";
import { createLogger } from "./kernel/logger.ts";
import { probeScopes } from "./kernel/supervisor/scope.ts";
import { killAllWorkerGroups } from "./kernel/supervisor/worker.ts";
import { VERSION } from "./kernel/version.ts";
import { execFileCode, execFileText, whichOnPath } from "./kernel/which.ts";
import { createDispatcher } from "./kernel/ws/dispatcher.ts";
import { createStreamHub } from "./kernel/ws/stream-hub.ts";
import { systemHandlers } from "./kernel/ws/system-handlers.ts";
import { createWsServer } from "./kernel/ws/ws-server.ts";
import { AUDIT_MIGRATIONS, createAuditModule } from "./modules/audit/index.ts";
import { AUTH_MIGRATIONS, requireStepUp } from "./modules/auth/index.ts";
import { createPolicyModule, POLICY_MIGRATIONS } from "./modules/policy/index.ts";
import { composeKnowledge } from "./compose-knowledge.ts";
import { createProjectsModule, PROJECTS_MIGRATIONS } from "./modules/projects/index.ts";
import { createSearchModule } from "./modules/search/index.ts";
import { createSessionsModule, resolveSessionCwd, SESSIONS_MIGRATIONS } from "./modules/sessions/index.ts";
import { createSettingsModule, SETTINGS_MIGRATIONS } from "./modules/settings/index.ts";
export type { DaemonDeps, DaemonHandle } from "./daemon-types.ts";

/**
 * Every migration source of the daemon, in order. The CLI migrates with this same constant, so a home the daemon
 * created never looks newer than the CLI to the CLI (M5R126): never a list written beside it.
 */
export const MIGRATION_SOURCES = [
  KERNEL_MIGRATIONS,
  AUTH_MIGRATIONS,
  POLICY_MIGRATIONS,
  PROJECTS_MIGRATIONS,
  SESSIONS_MIGRATIONS,
  SETTINGS_MIGRATIONS,
  AUDIT_MIGRATIONS,
  ...LANE_MIGRATIONS,
  ...M10_MIGRATION_SOURCES,
  ...M11_MIGRATION_SOURCES,
  PUSH_MIGRATIONS,
  ...USERS_MIGRATION_SOURCES,
] as const;

export async function createDaemon(config: Config, deps: DaemonDeps = {}): Promise<DaemonHandle> {
  const clock = deps.clock ?? createSystemClock();
  const logger =
    deps.logger ??
    createLogger({ level: config.logLevel, clock, write: (line) => process.stdout.write(line) });
  const workerUmask = prepareHome(config.home);
  const lock = acquireInstanceLock(config.home);
  // Undone in reverse order, by `stop()` and by a start that fails half-way.
  const closers: Array<{ readonly name: string; close(): void | Promise<void> }> = [
    { name: "instance_lock", close: () => lock.release() },
  ];
  const closeAll = async (): Promise<void> => {
    for (const closer of closers.splice(0).reverse()) {
      try {
        await closer.close();
      } catch (error) {
        logger.error("close_failed", { step: closer.name, err: error });
      }
    }
  };
  try {
    const { db, readOnly } = migrate({
      dbPath: join(config.home, "state.db"),
      backupsDir: join(config.home, "backups"),
      sources: MIGRATION_SOURCES,
      clock,
      logger,
    });
    closers.push({ name: "database", close: () => db.close() });
    const installedAt = ensureInstallTimestamp(db, clock);
    if (readOnly)
      logger.warn("read_only_mode", {
        hint: "This database was written by a newer pap. Upgrade pap or restore a backup.",
      });
    const audit = createAuditModule({ db, clock, logger });
    const prunable = audit.prunableAtBoot(clock.now());
    if (prunable)
      logger.info("audit_prunable", {
        ...prunable,
        hint: "Stop pap (systemctl --user stop pap-preview for the preview service), then run pap audit prune.",
      });
    const receipts = createReceiptStore(db, clock);
    const purge = startReceiptPurge(receipts, clock, logger);
    closers.push({ name: "receipt_purge", close: () => purge.stop() });
    const hub = createStreamHub(undefined, clock);
    const env = deps.env ?? process.env;
    const vmRpc = composeAgentsVmRpc(config, logger, clock, audit.port);
    closers.push({ name: "agent_files_sweep", close: vmRpc.stopSweep });
    const gh = createGithubCore(config, clock, logger);
    const core = { db, clock, logger, config, readOnly, hub, env, ...vmRpc.shared };
    const agentsVm = await composeAgentsVm(
      { ...core, githubLive: gh.tokens.liveValues },
      closers,
      deps.agentsVm,
    );
    vmRpc.bindVm(agentsVm);
    // The outbox is recovered before any module is built (M10R11).
    const m10 = composeM10Early(core, closers);
    const onOriginRefused = createOriginRefusalLog(logger, clock);
    const onFetchSiteRefused = createFetchSiteRefusalLog(logger, clock);
    const auth = composeAuth(core, audit);
    vmRpc.claudeToken.migrateLegacy(auth.ownerId());
    const scopes = await (deps.probeScopes ?? probeScopes)(config.workerScope, config.workerLimits, {
      home: config.home,
      uid: process.getuid?.() ?? -1,
      exec: execFileText,
      execSync: execFileCode,
      env,
      which: (command) => whichOnPath(command, env),
      clock,
      logger,
    });
    // What an earlier daemon of this home left behind dies before any new worker starts (M2-RT-13).
    await scopes.sweep();
    // The sessions module is built after the policy module, which asks it who owns a session (M5R56).
    let ownerOf: (sessionId: string) => string | null = () => null;
    const policy = createPolicyModule({
      db,
      clock,
      logger,
      newId,
      audit: audit.port,
      sessionOwner: (sessionId) => ownerOf(sessionId),
      scopeAlias: (cwd) => lanes.paths.scopeOf(cwd),
    });
    // projects.add follows sessions.create's folder rules (decision 85, PH1); no project lives in pap's or Pi's own state.
    const projects = createProjectsModule({
      db,
      clock,
      logger,
      newId,
      audit: audit.port,
      isMember: auth.isMember,
      folders: {
        resolve: resolveSessionCwd,
        scopeOf: (real) => policy.port.scopeOf(real),
        stateDirs: [config.home, config.piAgentDir],
      },
      knowledge: composeKnowledge(audit.port, () => ({ projects, lanes, sessions })),
    });
    // The box source is bound before any module that reads a path is built: a box root is never a host path (C6).
    const boxes = composeBoxWiring({
      vm: agentsVm,
      projects,
      clock,
      logger,
      home: config.home,
      isMember: auth.isMember,
      agents: vmRpc.agentsPort,
      requireStepUp,
    });
    const allRoots = (owner: string) => [...projects.port.roots(owner), ...lanes.paths.roots(owner)];
    const wk = createWorkspaceModules(
      { roots: allRoots, config, clock, logger, env, hub, readOnly, scopes, ...boxes.workspace },
      workerUmask,
    );
    closers.push({ name: "workspace", close: () => wk.shutdown() });
    const lanes = composeLanes({
      ...core,
      wk,
      audit,
      roots: projects.port.roots,
      runs: m10.runs.port,
      boxes: boxes.workspace.boxes,
      isMember: auth.isMember,
    });
    await lanes.recover();
    const users = composeUsers({ ...core, audit: audit.port }, auth, agentsVm.relay, () => pi.models);
    const sessions = createSessionsModule({
      db,
      clock,
      logger,
      hub,
      policy: policy.port,
      projects: projects.port,
      ownerId: () => auth.ownerId(),
      // An adopted session starts tainted (agreement 8). It runs inside the adopting transaction, where the row exists
      // and no policy row does (epoch 0); a throw leaves no row, and the next scan adopts the file again.
      onAdopted: (sessionId) => {
        const owner = ownerOf(sessionId);
        if (owner === null) throw new Error("adopted session has no owner");
        policy.port.markTainted(owner, sessionId, 0);
      },
      audit: audit.port,
      runs: m10.observer,
      attachments: wk.attachments,
      config,
      workerUmask,
      env,
      scopes,
      vmLaunch: agentsVm.launch,
      boxes: boxes.workspace.boxes,
      isMember: auth.isMember,
      providers: users.providers,
      ...(deps.onWorkerExit ? { onWorkerExit: deps.onWorkerExit } : {}),
    });
    ownerOf = sessions.ownerOf;
    const search = createSearchModule({
      home: config.home,
      agentDir: config.piAgentDir,
      installedAt,
      readOnly,
      clock,
      logger,
      sessions: sessions.scanPort,
    });
    closers.push({ name: "search", close: () => search.stop() });
    const settings = createSettingsModule({ db, clock, logger, members: settingsMembersOf(auth) });
    const pi = composePi({ config, env, clock, logger, hub, audit, policy, projects, sessions, settings });
    lanes.bind({ sessions, pi, policy: policy.port, hub });
    const m10Late = composeM10(core, m10, { audit, auth, policy, projects, sessions, settings, wk, scopes });
    const m11 = composeM11(core, {
      sessions,
      policy,
      audit,
      lanes,
      git: wk.git,
      runs: m10.runs.port,
      automationModule: m10Late.automation,
      inbox: m10Late.inbox,
      settings,
      subagents: { pi, sessions },
      claudeEnvOf: createClaudeEnvOf({ sourcesOf: pi.plugins.sourcesOf, logger, daemonEnv: env }),
      vm: agentsVm,
      health: m10.health.port,
    });
    vmRpc.bindAgents(m11.agents);
    const boxesLate = boxes.bind({ sessions, automation: m10Late.automation, inbox: m10Late.inbox });
    const github = composeGithub(gh, { ...core, audit, auth, projects, sessions, policy, boxes, closers });
    // Before the users are bound: a disabled or deleted account revokes its preview tokens (UX2-R72).
    const previews = await composePreviews(core, closers);
    const previewsBound = previews.bind(previewsLate({ vm: agentsVm, boxes, sessions, m11 }));
    const memberLine = users.bind({ runs: m10.runs, settings, boxes, agents: m11.agents, agentsVm });
    users.bindDelete({ github, projects, m11, m10Late, sessions, search, previews: previews.tokens });
    agentsVm.bindLate({
      sessions,
      pi,
      ...m11.vmLate,
      runs: m10.runs,
      policy: policy.port,
      automation: m10Late.automation,
      boxes: boxesLate,
      providers: users.providers,
      memberLine,
    });
    const agents = { port: m11.agents };
    const push = composePush(
      { ...core, closers, m10, inbox: m10Late.inbox, auth, settings, sessions, audit, agents },
      deps.push,
    );
    const fonts = composeFonts(core, deps.fontsFetcher);
    const handlers: HandlerTable = {
      ...systemHandlers(clock),
      ...audit.rpc,
      ...auth.rpc,
      ...policy.rpc,
      ...projects.rpc,
      ...wk.rpc,
      ...sessions.rpc,
      ...search.rpc,
      ...settings.rpc,
      ...pi.rpc,
      ...lanes.rpc,
      ...m10Late.rpc,
      ...m11.rpc,
      ...vmRpc.rpc,
      ...push.rpc,
      ...fonts.rpc,
      ...github.rpc,
      ...users.rpc,
      ...m10.health.rpc,
      ...previewsBound.rpc,
    };
    const dispatch = createDispatcher({
      handlers,
      receipts,
      logger,
      gate: boxes.workspace.gate,
      onCall: m10.onCall,
    });
    const ws = createWsServer({
      allowedOrigins: config.allowedOrigins,
      credentialOf: auth.credentialOf,
      authenticate: auth.authenticateCredential,
      dispatch,
      hub,
      logger,
      clock,
      serverVersion: VERSION,
      onOriginRefused,
      onFetchSiteRefused,
    });
    const wsProbe = createWsProbe(auth);
    const app = createHttpApp({
      allowedOrigins: config.allowedOrigins,
      staticRoot: config.staticRoot,
      logger,
      servesTls: config.tls !== null,
      onOriginRefused,
      onFetchSiteRefused,
      frameSrc: previews.origin,
      mount: (hono) => {
        auth.mount(hono);
        wk.mount(hono, auth.authenticateCookieHeader);
        sessions.mountExportRoute(hono, auth.authenticateCookieHeader);
        m10Late.mount(hono);
        fonts.mount(hono);
        vmRpc.mount(hono, auth.authenticateCookieHeader);
        github.mount(hono);
      },
      wsProbe,
    });
    let fatal = false;
    const server = await startServer({
      app,
      host: config.host,
      port: config.port,
      tls: config.tls,
      onUpgrade: (req, socket, head) => ws.handleUpgrade(req, socket, head),
      onError: (error) => {
        logger.error("server_error", { code: error.code });
        if (fatal) return;
        fatal = true;
        deps.onFatal?.("server_error");
      },
    });
    // Pushed once the server is up: closing goes ws first, then http, then the entries above.
    closers.push({ name: "http", close: () => server.close() }, { name: "ws", close: () => ws.close() });
    const setupUrl = announceStart(config, logger, deps, auth.setupUrl());
    search.start();
    m10Late.start();
    logger.info("listening", { url: config.publicOrigin, host: config.host, port: server.port });

    let stopping: Promise<void> | undefined;
    return {
      url: config.publicOrigin,
      port: server.port,
      setupUrl,
      inspect: {
        workerPid: (id) => sessions.inspect(id)?.pid,
        workerRssMb: (id) => sessions.inspect(id)?.rssMb ?? null,
        sessionCost: (id) => m10.runs.port.sessionCost(id),
        routes: () => app.routes.map((route) => `${route.method} ${route.path}`),
        previews: () => previewsBound.registry,
      },
      killScopes: () => scopes.killAllNow(),
      stop() {
        stopping ??= (async () => {
          m11.stop();
          await m10Late.stop();
          // Each worker climbs its own ladder (shutdown request, SIGTERM, SIGKILL) and pi-host cleans up Pi's bash
          // trees on the way; SIGKILL to every group first would leak them (R104).
          await Promise.all([pi.stopAll(), sessions.shutdownAll(), lanes.shutdown()]);
          await wk.shutdown();
          killAllWorkerGroups();
          await closeAll();
        })();
        return stopping;
      },
    };
  } catch (error) {
    await closeAll();
    throw error;
  }
}
