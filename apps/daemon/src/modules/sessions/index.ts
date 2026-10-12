import { freemem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Config } from "../../kernel/config.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import { newId } from "../../kernel/ids.ts";
import type { Logger } from "../../kernel/logger.ts";
import { workerEnv } from "../../kernel/supervisor/env.ts";
import type { WorkerExit } from "../../kernel/supervisor/exit.ts";
import type { WorkerScopes } from "../../kernel/supervisor/scope.ts";
import { spawnWorker } from "../../kernel/supervisor/worker.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { Hono } from "hono";
import type { PolicyPort } from "../policy/index.ts";
import { mountExportRoute } from "./export-http.ts";
import { createExports } from "./exports.ts";
import { loadPiWriter, purgeForkTmp } from "./pi-writer.ts";
import { type SessionsRpc, sessionsRpc } from "./rpc.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { loadTranscriptReader } from "./transcript.ts";

export { createExports, type Exports } from "./exports.ts";
export { loadPiWriter, type PiWriter } from "./pi-writer.ts";

export const SESSIONS_MIGRATIONS: MigrationSource = {
  module: "sessions",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface SessionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  /** The policy module: the project's "always" rules, and where an "always" answer is saved (Task 14b). */
  readonly policy: PolicyPort;
  readonly config: Pick<
    Config,
    | "home"
    | "piAgentDir"
    | "piHostEntry"
    | "piHostExecArgv"
    | "testProviderScript"
    | "maxWorkers"
    | "minFreeMemMb"
    | "workerIdleMs"
  >;
  /** The umask the daemon was started with, before it set its own 077: what the workers' tools run under (R114). */
  readonly workerUmask: number;
  readonly env: NodeJS.ProcessEnv;
  readonly scopes: WorkerScopes;
  /** After a worker exited: its session and the end of its output (the supervisor keeps 8 KiB). */
  readonly onWorkerExit?: (sessionId: string, info: { exit: WorkerExit; outputTail: string }) => void;
}

export interface SessionsModule {
  readonly rpc: SessionsRpc;
  /** The download route of HTML exports (ADR 0006). It checks the session cookie itself, with `authenticate`. */
  mountExportRoute(
    app: Hono,
    authenticate: (cookieHeader: string | undefined) => { userId: string } | null,
  ): void;
  shutdownAll(): Promise<void>;
  inspect(sessionId: string): { pid: number | undefined; rssMb: number | null } | null;
}

export function createSessionsModule(deps: SessionsModuleDeps): SessionsModule {
  const logger = deps.logger.child({ module: "sessions" });
  const { config } = deps;
  if (config.testProviderScript) {
    logger.warn("test_provider_enabled", { note: "sessions run on a scripted model: for tests only" });
  }
  // Pi derives its session directory from PI_CODING_AGENT_DIR, and the worker refuses to start when that differs from
  // the agent directory of its init record. PAP_TEST_PROVIDER goes with a test script and nothing else (ADR 0001).
  const env = workerEnv(deps.env, {
    PI_CODING_AGENT_DIR: config.piAgentDir,
    ...(config.testProviderScript ? { PAP_TEST_PROVIDER: "1" } : {}),
  });
  // What an earlier daemon left in the exports directory goes before anything can be exported (M2R96).
  const exports = createExports({ dir: join(config.home, "exports"), clock: deps.clock, logger });
  exports.purgeAll();
  // The working copies of sources are deleted when each fork ends; a crash in the middle leaves one, deleted here.
  const forkTmpDir = join(config.home, "fork-tmp");
  purgeForkTmp(forkTmpDir, logger);
  const service = createSessionsService({
    store: createSessionsStore(deps.db),
    exports,
    clock: deps.clock,
    logger,
    hub: deps.hub,
    policy: deps.policy,
    limits: { maxWorkers: config.maxWorkers, minFreeMemMb: config.minFreeMemMb },
    idleMs: config.workerIdleMs,
    worker: {
      agentDir: config.piAgentDir,
      papHome: config.home,
      umask: deps.workerUmask,
      testProviderScript: config.testProviderScript,
    },
    newId,
    loadTranscript: () => loadTranscriptReader({ logger, clock: deps.clock }),
    loadWriter: () => loadPiWriter(forkTmpDir, { logger }),
    freeMemMb: () => Math.floor(freemem() / 1_048_576),
    spawn: (cwd) => {
      const scope = deps.scopes.next();
      return spawnWorker({
        entry: config.piHostEntry,
        execArgv: config.piHostExecArgv,
        cwd,
        env,
        clock: deps.clock,
        logger: logger.child({ component: "worker", ...(scope ? { unit: scope.unit } : {}) }),
        ...(scope ? { scope } : {}),
      });
    },
    ...(deps.onWorkerExit ? { onWorkerExit: deps.onWorkerExit } : {}),
  });
  deps.hub.registerSnapshot("session", (key) => service.snapshot(key));
  return {
    rpc: sessionsRpc(service),
    mountExportRoute: (app, authenticate) => mountExportRoute(app, { exports, authenticate, logger }),
    async shutdownAll() {
      try {
        await service.shutdownAll();
      } finally {
        exports.stop();
      }
    },
    inspect: (sessionId) => service.inspect(sessionId),
  };
}
