import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@pap/contracts";
import { createDaemon, type DaemonDeps, type DaemonHandle } from "../daemon.ts";
import type { Config } from "../kernel/config.ts";
import type { WorkerExit } from "../kernel/supervisor/exit.ts";
import { silentLogger } from "../kernel/logger.ts";
import { freePort } from "./free-port.ts";
import { httpRequest } from "./http-client.ts";
import { selfSignedCertificate } from "./self-signed.ts";
import { connectTestClient, type TestClient } from "./ws-client.ts";

const OWNER_PASSWORD = "correct horse battery staple";
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

export interface TestDaemon {
  readonly daemon: DaemonHandle;
  readonly origin: string;
  /** The address a client connects to; `origin` is what the browser would show. */
  readonly base: string;
  readonly port: number;
  readonly cwd: string;
  readonly root: string;
  readonly home: string;
  login(): Promise<string>;
  connect(cookie: string): Promise<TestClient>;
  /** A bearer-token connection: no cookie, and an Origin only when `origin` is given. */
  connectBearer(token: string, origin?: string): Promise<TestClient>;
  /** Confirms the harness owner's password for this session (`POST /auth/confirm`): step-up for the next minutes. */
  confirmStepUp(cookie: string): Promise<void>;
  stop(): Promise<void>;
}

export interface TestDaemonOptions {
  /** Serve TLS with a throwaway self-signed certificate: for HTTP checks only, `connect()` speaks plain ws. */
  readonly tls?: boolean;
  readonly config?: Partial<Config>;
  /** Pi extensions written as `<agent dir>/extensions/<name>.js` before the daemon starts. */
  readonly extensions?: Record<string, string>;
  /** Files written under the agent directory before the daemon starts, by relative path (`mcp.json`, `extensions/x.js`). */
  readonly agentFiles?: Readonly<Record<string, string>>;
  /** Extra worker environment (a fake `GITHUB_TOKEN`), added to the harness defaults; `HOME` and `PI_*` are refused. */
  readonly workerEnv?: Readonly<Record<string, string>>;
  readonly deps?: Omit<DaemonDeps, "env">;
}

/**
 * A daemon on a free port in a temporary home, its workers on the scripted provider and under the network guard:
 * nothing reaches a real provider or the real ~/.pi/agent and ~/.pap (R94).
 */
export async function startTestDaemon(script: object, options: TestDaemonOptions = {}): Promise<TestDaemon> {
  const root = mkdtempSync(join(tmpdir(), "pap-int-"));
  try {
    return await startIn(root, script, options);
  } catch (error) {
    // Whatever failed (a certificate, a lock, a taken port), the directory it made goes with it.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function startIn(root: string, script: object, options: TestDaemonOptions): Promise<TestDaemon> {
  for (const key of Object.keys(options.workerEnv ?? {})) {
    if (key === "HOME" || key.startsWith("PI_"))
      throw new Error(`workerEnv cannot set ${key}: it isolates the worker`);
  }
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const userHome = join(root, "user");
  for (const dir of [agentDir, cwd, userHome]) mkdirSync(dir);
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  if (options.extensions) {
    mkdirSync(join(agentDir, "extensions"));
    for (const [name, source] of Object.entries(options.extensions))
      writeFileSync(join(agentDir, "extensions", `${name}.js`), source);
  }
  for (const [file, content] of Object.entries(options.agentFiles ?? {})) {
    const target = join(agentDir, file);
    if (file.split(/[\\/]/).includes("..") || relative(agentDir, target).startsWith(".."))
      throw new Error(`agent file outside the agent directory: ${file}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const port = await freePort();
  const scheme = options.tls ? "https" : "http";
  const origin = `${scheme}://localhost:${port}`;
  const base = `${scheme}://127.0.0.1:${port}`;
  const files = options.tls ? selfSignedCertificate(root) : null;
  const tls = files ? { cert: readFileSync(files.cert), key: readFileSync(files.key) } : null;
  const config: Config = {
    home: join(root, "home"),
    host: "127.0.0.1",
    port,
    dev: false,
    tls,
    insecureHttp: false,
    publicOrigin: origin,
    allowedOrigins: new Set([origin, base]),
    piAgentDir: agentDir,
    userHome,
    piHostEntry: join(REPO, "packages/pi-host/src/main.ts"),
    piHostExecArgv: [
      "--conditions=development",
      "--disable-warning=ExperimentalWarning",
      "--import",
      join(REPO, "packages/pi-host/src/testing/network-guard.ts"),
    ],
    testProviderScript: scriptPath,
    testGitProtocols: null,
    maxWorkers: 4,
    minFreeMemMb: 0,
    minFreeDiskMb: 0,
    maxTerminals: 8,
    workerIdleMs: 30 * 60_000,
    workerScope: "off",
    workerLimits: { memoryMaxMb: 2048, tasksMax: 4096 },
    helpersMax: 4,
    metricsToken: null,
    otlp: null,
    staticRoot: null,
    logLevel: "warn",
    ...options.config,
  };
  // Not the whole environment: whatever PI_* and HOME the outer process has must not reach a worker.
  const env = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    ...options.workerEnv,
    HOME: userHome,
    PI_OFFLINE: "1",
  };
  const exits: Array<{ sessionId: string; exit: WorkerExit; outputTail: string }> = [];
  const daemon = await createDaemon(config, {
    logger: silentLogger,
    ...options.deps,
    onWorkerExit: (sessionId, info) => {
      exits.push({ sessionId, ...info });
      options.deps?.onWorkerExit?.(sessionId, info);
    },
    env,
  });
  return {
    daemon,
    origin,
    base,
    port,
    cwd,
    root,
    home: config.home,
    async login() {
      const token = new URL(daemon.setupUrl ?? "http://invalid").hash.replace("#token=", "");
      const reply = await httpRequest(`${base}/auth/setup`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token, username: "owner", password: OWNER_PASSWORD }),
      });
      if (reply.status !== 201) throw new Error(`setup failed: ${reply.status} ${reply.body}`);
      const header = reply.headers["set-cookie"];
      return ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
    },
    connect: async (cookie) => {
      if (tls) throw new Error("connect() is not available on a TLS test daemon");
      return connectTestClient(`ws://127.0.0.1:${port}/ws?proto=${PROTOCOL_VERSION}`, { origin, cookie });
    },
    connectBearer: async (token, bearerOrigin) => {
      if (tls) throw new Error("connectBearer() is not available on a TLS test daemon");
      return connectTestClient(`ws://127.0.0.1:${port}/ws?proto=${PROTOCOL_VERSION}`, {
        authorization: `Bearer ${token}`,
        ...(bearerOrigin === undefined ? {} : { origin: bearerOrigin }),
      });
    },
    async confirmStepUp(cookie) {
      const reply = await httpRequest(`${base}/auth/confirm`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ password: OWNER_PASSWORD }),
      });
      if (reply.status !== 204) throw new Error(`confirm failed: ${reply.status} ${reply.body}`);
    },
    async stop() {
      try {
        await daemon.stop();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      // A connection the guard refused may have been swallowed by the code that tried it: the worker's output still
      // says so (R94, R118). Only the last 8 KiB of each worker's output are kept (R102): a refusal followed by more
      // than that of other output is not seen.
      const blocked = exits
        .flatMap((exit) => exit.outputTail.split("\n"))
        .filter((line) => line.startsWith("pap-network-guard: blocked"));
      if (blocked.length > 0) throw new Error(`a worker tried to reach the network:\n${blocked.join("\n")}`);
    },
  };
}
