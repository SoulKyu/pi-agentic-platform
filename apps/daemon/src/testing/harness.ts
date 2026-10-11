import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@pap/contracts";
import { createDaemon, type DaemonDeps, type DaemonHandle } from "../daemon.ts";
import type { Config } from "../kernel/config.ts";
import { silentLogger } from "../kernel/logger.ts";
import { freePort } from "./free-port.ts";
import { httpRequest } from "./http-client.ts";
import { connectTestClient, type TestClient } from "./ws-client.ts";

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
  stop(): Promise<void>;
}

export interface TestDaemonOptions {
  /** Serve TLS with a throwaway self-signed certificate: for HTTP checks only, `connect()` speaks plain ws. */
  readonly tls?: boolean;
  readonly config?: Partial<Config>;
  readonly deps?: Omit<DaemonDeps, "env">;
}

/**
 * A daemon on a free port in a temporary home, its workers on the scripted provider and under the network guard:
 * nothing reaches a real provider or the real ~/.pi/agent and ~/.pap (R94).
 */
export async function startTestDaemon(script: object, options: TestDaemonOptions = {}): Promise<TestDaemon> {
  const root = mkdtempSync(join(tmpdir(), "pap-int-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  const userHome = join(root, "user");
  for (const dir of [agentDir, cwd, userHome]) mkdirSync(dir);
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const port = await freePort();
  const scheme = options.tls ? "https" : "http";
  const origin = `${scheme}://localhost:${port}`;
  const base = `${scheme}://127.0.0.1:${port}`;
  const tls = options.tls ? selfSignedCertificate(root) : null;
  const config: Config = {
    home: join(root, "home"),
    host: "127.0.0.1",
    port,
    dev: false,
    tls,
    publicOrigin: origin,
    allowedOrigins: new Set([origin, base]),
    piAgentDir: agentDir,
    piHostEntry: join(REPO, "packages/pi-host/src/main.ts"),
    piHostExecArgv: [
      "--conditions=development",
      "--disable-warning=ExperimentalWarning",
      "--import",
      join(REPO, "packages/pi-host/src/testing/network-guard.ts"),
    ],
    testProviderScript: scriptPath,
    maxWorkers: 4,
    minFreeMemMb: 0,
    staticRoot: null,
    logLevel: "warn",
    ...options.config,
  };
  // Not the whole environment: whatever PI_* and HOME the outer process has must not reach a worker.
  const env = { PATH: process.env.PATH, LANG: process.env.LANG, HOME: userHome, PI_OFFLINE: "1" };
  const daemon = await createDaemon(config, { logger: silentLogger, ...options.deps, env }).catch(
    (error: unknown) => {
      rmSync(root, { recursive: true, force: true });
      throw error;
    },
  );
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
        body: JSON.stringify({ token, username: "owner", password: "correct horse battery staple" }),
      });
      if (reply.status !== 201) throw new Error(`setup failed: ${reply.status} ${reply.body}`);
      const header = reply.headers["set-cookie"];
      return ((Array.isArray(header) ? header[0] : header) ?? "").split(";")[0] ?? "";
    },
    connect: async (cookie) => {
      if (tls) throw new Error("connect() is not available on a TLS test daemon");
      return connectTestClient(`ws://127.0.0.1:${port}/ws?proto=${PROTOCOL_VERSION}`, { origin, cookie });
    },
    async stop() {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function selfSignedCertificate(dir: string): { cert: string; key: string } {
  const files = { cert: join(dir, "cert.pem"), key: join(dir, "key.pem") };
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
    ].concat(["-subj", "/CN=localhost", "-keyout", files.key, "-out", files.cert]),
    { stdio: "ignore" },
  );
  return files;
}
