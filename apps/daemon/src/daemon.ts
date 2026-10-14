import { join } from "node:path";
import { PROTOCOL_VERSION, type HandlerTable } from "@pap/contracts";
import type { Context } from "hono";
import { createWorkspaceModules } from "./compose-workspace.ts";
import { createSystemClock, type Clock } from "./kernel/clock.ts";
import { type Config, VITE_DEV_ORIGIN } from "./kernel/config.ts";
import { ensureInstallTimestamp } from "./kernel/db/meta.ts";
import { KERNEL_MIGRATIONS, migrate } from "./kernel/db/migrate.ts";
import { createReceiptStore, startReceiptPurge } from "./kernel/db/receipts.ts";
import { acquireInstanceLock, prepareHome } from "./kernel/home.ts";
import { createHttpApp } from "./kernel/http/app.ts";
import { createOriginRefusalLog } from "./kernel/http/origin-refusals.ts";
import { startServer } from "./kernel/http/server.ts";
import { newId } from "./kernel/ids.ts";
import { createLogger, type Logger } from "./kernel/logger.ts";
import type { WorkerExit } from "./kernel/supervisor/exit.ts";
import { probeScopes } from "./kernel/supervisor/scope.ts";
import { killAllWorkerGroups } from "./kernel/supervisor/worker.ts";
import { VERSION } from "./kernel/version.ts";
import { execFileCode, execFileText, whichOnPath } from "./kernel/which.ts";
import { createDispatcher } from "./kernel/ws/dispatcher.ts";
import { createStreamHub } from "./kernel/ws/stream-hub.ts";
import { systemHandlers } from "./kernel/ws/system-handlers.ts";
import { createWsServer } from "./kernel/ws/ws-server.ts";
import { AUDIT_MIGRATIONS, createAuditModule } from "./modules/audit/index.ts";
import { AUTH_MIGRATIONS, createAuthModule } from "./modules/auth/index.ts";
import { createPolicyModule, POLICY_MIGRATIONS } from "./modules/policy/index.ts";
import { createProjectsModule, PROJECTS_MIGRATIONS } from "./modules/projects/index.ts";
import { createSearchModule } from "./modules/search/index.ts";
import { createSessionsModule, SESSIONS_MIGRATIONS } from "./modules/sessions/index.ts";
import { createSettingsModule, SETTINGS_MIGRATIONS } from "./modules/settings/index.ts";

export interface DaemonHandle {
  readonly url: string;
  readonly port: number;
  /** The one-time owner setup address while no owner exists; in `--dev` it carries the Vite dev origin (R31). */
  readonly setupUrl: string | null;
  readonly inspect: {
    workerPid(sessionId: string): number | undefined;
    workerRssMb(sessionId: string): number | null;
  };
  /** Idempotent. Workers go first (R104), then the sockets, the receipt purge, the database and the instance lock. */
  stop(): Promise<void>;
  /** A stop was given up: SIGKILLs every worker scope of this home, synchronously and bounded. Never throws. */
  killScopes(): void;
}

export interface DaemonDeps {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The HTTP server raised an error after it started: the caller stops the daemon and exits non-zero (R75). Called
   * once, however many errors follow: a second call would look like a second signal and cut the shutdown short (R115).
   */
  readonly onFatal?: (reason: "server_error") => void;
  /**
   * Where the one-time setup address goes. Defaults to `logger.info("setup_url")`; `pap serve` prints it whatever
   * PAP_LOG_LEVEL is, because without it nobody can create the owner (R117).
   */
  readonly announceSetupUrl?: (fields: { readonly url: string; readonly hint: string }) => void;
  /** A worker exited: its session and the end of what it printed (at most the supervisor's 8 KiB tail). */
  readonly onWorkerExit?: (sessionId: string, info: { exit: WorkerExit; outputTail: string }) => void;
  /** Tests only: replaces the boot probe of the worker scopes. */
  readonly probeScopes?: typeof probeScopes;
}

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
] as const;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

// In `--dev` the browser talks to Vite, which proxies to the daemon: that is the address to open (R31).
function openableSetupUrl(config: Config, setupUrl: string | null): string | null {
  if (!setupUrl || !config.dev) return setupUrl;
  const url = new URL(setupUrl);
  const vite = new URL(VITE_DEV_ORIGIN);
  url.protocol = vite.protocol;
  url.host = vite.host;
  return url.href;
}

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

    const onOriginRefused = createOriginRefusalLog(logger, clock);
    const hub = createStreamHub(undefined, clock);
    const auth = createAuthModule({
      db,
      clock,
      logger,
      publicOrigin: config.publicOrigin,
      allowedOrigins: config.allowedOrigins,
      insecureHttp: config.insecureHttp,
      audit: audit.port,
      secretsDir: join(config.home, "secrets"),
    });
    const env = deps.env ?? process.env;
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
    });
    const projects = createProjectsModule({ db, clock, logger, newId });
    const wk = createWorkspaceModules(
      { roots: projects.port.roots, config, clock, logger, env, hub, readOnly, scopes },
      workerUmask,
    );
    closers.push({ name: "workspace", close: () => wk.shutdown() });
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
      attachments: wk.attachments,
      config,
      workerUmask,
      env,
      scopes,
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
    const settings = createSettingsModule({ db, clock, logger });
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
    };
    const dispatch = createDispatcher({ handlers, receipts, logger });
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
    });
    // The browser cannot read the status of a failed upgrade, so the client asks this plain GET first.
    const wsProbe = (c: Context) => {
      if (c.req.query("proto") !== String(PROTOCOL_VERSION))
        return c.json({ protocol: PROTOCOL_VERSION }, 426);
      const credential = auth.credentialOf({
        cookie: c.req.header("cookie"),
        authorization: c.req.header("authorization"),
      });
      if (credential === "conflict") return c.json({ error: { code: "bad_request" } }, 400);
      if (!auth.authenticateCredential(credential))
        return c.json({ error: { code: "unauthenticated" } }, 401);
      return c.json({ protocol: PROTOCOL_VERSION });
    };
    const app = createHttpApp({
      allowedOrigins: config.allowedOrigins,
      staticRoot: config.staticRoot,
      logger,
      servesTls: config.tls !== null,
      onOriginRefused,
      mount: (hono) => {
        auth.mount(hono);
        wk.mount(hono, auth.authenticateCookieHeader);
        sessions.mountExportRoute(hono, auth.authenticateCookieHeader);
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

    const setupUrl = openableSetupUrl(config, auth.setupUrl());
    if (setupUrl) {
      const fields = { url: setupUrl, hint: "Open this URL once to create the owner account." };
      if (deps.announceSetupUrl) deps.announceSetupUrl(fields);
      else logger.info("setup_url", fields);
    }
    if (!LOOPBACK.has(config.host) && !config.tls) {
      logger.warn("plain_http_on_network", {
        hint: "Passkeys, secure cookies and Web Push need HTTPS: use Tailscale serve, a reverse proxy or --tls-cert/--tls-key. Browsers on other machines are only accepted under the address in PAP_PUBLIC_ORIGIN; set it to the one they type.",
      });
    }
    if (config.insecureHttp) {
      logger.warn("insecure_http", {
        hint: "--insecure-http: session cookies travel without Secure over plain HTTP, readable by anyone on the network, and so is a terminal's shell (sniffing the cookie opens one). For testing on a trusted LAN only.",
      });
    }
    search.start();
    logger.info("listening", { url: config.publicOrigin, host: config.host, port: server.port });

    let stopping: Promise<void> | undefined;
    return {
      url: config.publicOrigin,
      port: server.port,
      setupUrl,
      inspect: {
        workerPid: (id) => sessions.inspect(id)?.pid,
        workerRssMb: (id) => sessions.inspect(id)?.rssMb ?? null,
      },
      killScopes: () => scopes.killAllNow(),
      stop() {
        stopping ??= (async () => {
          // Each worker climbs its own ladder (shutdown request, SIGTERM, SIGKILL) and pi-host cleans up Pi's bash
          // trees on the way; SIGKILL to every group first would leak them (R104).
          await sessions.shutdownAll();
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
