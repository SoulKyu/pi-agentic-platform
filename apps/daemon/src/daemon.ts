import { join } from "node:path";
import { PROTOCOL_VERSION, type HandlerTable } from "@pap/contracts";
import type { Context } from "hono";
import { createSystemClock, type Clock } from "./kernel/clock.ts";
import { type Config, VITE_DEV_ORIGIN } from "./kernel/config.ts";
import { ensureInstallTimestamp } from "./kernel/db/meta.ts";
import { KERNEL_MIGRATIONS, migrate } from "./kernel/db/migrate.ts";
import { createReceiptStore, startReceiptPurge } from "./kernel/db/receipts.ts";
import { acquireInstanceLock, prepareHome } from "./kernel/home.ts";
import { createHttpApp } from "./kernel/http/app.ts";
import { startServer } from "./kernel/http/server.ts";
import { createLogger, type Logger } from "./kernel/logger.ts";
import { killAllWorkerGroups } from "./kernel/supervisor/worker.ts";
import { VERSION } from "./kernel/version.ts";
import { createDispatcher } from "./kernel/ws/dispatcher.ts";
import { createStreamHub } from "./kernel/ws/stream-hub.ts";
import { systemHandlers } from "./kernel/ws/system-handlers.ts";
import { createWsServer } from "./kernel/ws/ws-server.ts";
import { AUTH_MIGRATIONS, createAuthModule } from "./modules/auth/index.ts";
import { createSessionsModule, SESSIONS_MIGRATIONS } from "./modules/sessions/index.ts";

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
}

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
      sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS, SESSIONS_MIGRATIONS],
      clock,
      logger,
    });
    closers.push({ name: "database", close: () => db.close() });
    ensureInstallTimestamp(db, clock);
    if (readOnly)
      logger.warn("read_only_mode", {
        hint: "This database was written by a newer pap. Upgrade pap or restore a backup.",
      });
    const receipts = createReceiptStore(db, clock);
    const purge = startReceiptPurge(receipts, clock, logger);
    closers.push({ name: "receipt_purge", close: () => purge.stop() });

    const hub = createStreamHub();
    const auth = createAuthModule({
      db,
      clock,
      logger,
      publicOrigin: config.publicOrigin,
      allowedOrigins: config.allowedOrigins,
    });
    const sessions = createSessionsModule({
      db,
      clock,
      logger,
      hub,
      config,
      workerUmask,
      env: deps.env ?? process.env,
    });
    const handlers: HandlerTable = { ...systemHandlers(clock), ...sessions.rpc };
    const dispatch = createDispatcher({ handlers, receipts, logger });
    const ws = createWsServer({
      allowedOrigins: config.allowedOrigins,
      authenticate: (cookie) => auth.authenticateCookieHeader(cookie),
      dispatch,
      hub,
      logger,
      clock,
      serverVersion: VERSION,
    });
    // The browser cannot read the status of a failed upgrade, so the client asks this plain GET first.
    const wsProbe = (c: Context) => {
      if (c.req.query("proto") !== String(PROTOCOL_VERSION))
        return c.json({ protocol: PROTOCOL_VERSION }, 426);
      if (!auth.authenticateCookieHeader(c.req.header("cookie")))
        return c.json({ error: { code: "unauthenticated" } }, 401);
      return c.json({ protocol: PROTOCOL_VERSION });
    };
    const app = createHttpApp({
      allowedOrigins: config.allowedOrigins,
      staticRoot: config.staticRoot,
      logger,
      servesTls: config.tls !== null,
      mount: (hono) => auth.mount(hono),
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
        hint: "Passkeys, secure cookies and Web Push need HTTPS: use Tailscale serve, a reverse proxy or --tls-cert/--tls-key.",
      });
    }
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
      stop() {
        stopping ??= (async () => {
          // Each worker climbs its own ladder (shutdown request, SIGTERM, SIGKILL) and pi-host cleans up Pi's bash
          // trees on the way; SIGKILL to every group first would leak them (R104).
          await sessions.shutdownAll();
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
