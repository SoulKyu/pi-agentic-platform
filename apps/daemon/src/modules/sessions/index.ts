import { freemem } from "node:os";
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
import { type SessionsRpc, sessionsRpc } from "./rpc.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { loadTranscriptReader } from "./transcript.ts";

export const SESSIONS_MIGRATIONS: MigrationSource = {
  module: "sessions",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface SessionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  readonly config: Pick<
    Config,
    | "home"
    | "piAgentDir"
    | "piHostEntry"
    | "piHostExecArgv"
    | "testProviderScript"
    | "maxWorkers"
    | "minFreeMemMb"
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
  const service = createSessionsService({
    store: createSessionsStore(deps.db),
    clock: deps.clock,
    logger,
    hub: deps.hub,
    limits: { maxWorkers: config.maxWorkers, minFreeMemMb: config.minFreeMemMb },
    worker: {
      agentDir: config.piAgentDir,
      papHome: config.home,
      umask: deps.workerUmask,
      testProviderScript: config.testProviderScript,
    },
    newId,
    loadTranscript: () => loadTranscriptReader({ logger, clock: deps.clock }),
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
    shutdownAll: () => service.shutdownAll(),
    inspect: (sessionId) => service.inspect(sessionId),
  };
}
