import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createHelperPool, type HelperPool } from "../../kernel/helper/pool.ts";
import { type LogFields, type Logger, silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createMcpService } from "./service.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/helper/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const FIXTURE = join(REPO, "packages/pi-host/src/testing/mcp-fixture.mjs");
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];
const DEADLINE_MS = 3_000;

let root: string;
let agentDir: string;
let project: string;
let pool: HelperPool;
let logs: Array<{ msg: string; fields: LogFields | undefined }>;
const logger: Logger = { ...silentLogger, warn: (msg, fields) => void logs.push({ msg, fields }) };
const caller = () => testCaller({ stepUpUntil: Date.now() + 600_000 });
const service = (testDeadlineMs: number) =>
  createMcpService({
    helpers: pool,
    projects: { covers: (_o, cwd) => cwd.startsWith(project) },
    logger,
    clock: createSystemClock(),
    testDeadlineMs,
  });
const fixture = (config: object, env?: Record<string, string>) => ({
  command: process.execPath,
  args: [FIXTURE, JSON.stringify(config)],
  ...(env ? { env } : {}),
});
const node = (script: string, ...rest: string[]) => ({
  command: process.execPath,
  args: ["-e", script, ...rest],
});
const writeGlobal = (servers: Record<string, unknown>) =>
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-mcpt-int-")));
  agentDir = join(root, "home", ".pi", "agent");
  project = join(root, "home", "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(root, "pap"));
  logs = [];
  pool = createHelperPool({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    baseEnv: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      HOME: join(root, "home"),
      PI_OFFLINE: "1",
      // What only the daemon holds (stripped by the pool) next to an ordinary variable (kept, as for a worker).
      PAP_SESSION_SECRET: "sk-DAEMON-ONLY-1",
      NODE_OPTIONS: "--max-old-space-size=64",
      NOTIFY_SOCKET: "/run/systemd/notify",
      PROBE_VISIBLE: "yes",
    },
    agentDir,
    papHome: join(root, "pap"),
    max: 2,
    clock: createSystemClock(),
    logger,
  });
});
afterEach(async () => {
  try {
    await pool.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(JSON.stringify(logs)).not.toContain("pap-network-guard: blocked");
});

describe("mcp.test through a real helper and Pi's MCP extension", () => {
  it("connects a working stdio server and lists its tool names", async () => {
    writeGlobal({
      fix: fixture({
        tools: [
          { name: "echo", reply: "a" },
          { name: "ping", reply: "b" },
        ],
      }),
    });
    const result = await service(15_000).test(caller(), { scope: "global", name: "fix" });
    expect(result).toMatchObject({ state: "connected", tools: ["echo", "ping"], toolsTruncated: false });
    expect(result.message).toBeNull();
    await vi.waitFor(() => expect(pool.active()).toBe(0), { timeout: 10_000 });
  });

  it("tests a disabled server and a server whose exposure hides its tools as they are written", async () => {
    writeGlobal({
      off: { ...fixture({ tools: [{ name: "echo", reply: "a" }] }), enabled: false, exposure: "hidden" },
    });
    const result = await service(15_000).test(caller(), { scope: "global", name: "off" });
    expect(result).toMatchObject({ state: "connected", tools: ["echo"] });
  });

  it("answers failed within the deadline for a command that exits at once, and frees the helper slot", async () => {
    writeGlobal({ gone: node("process.exit(3)") });
    const started = Date.now();
    const result = await service(15_000).test(caller(), { scope: "global", name: "gone" });
    expect(result.state).toBe("failed");
    expect(result.tools).toEqual([]);
    expect(result.message).toEqual(expect.stringContaining("gone"));
    expect(Date.now() - started).toBeLessThan(15_000);
    await vi.waitFor(() => expect(pool.active()).toBe(0), { timeout: 10_000 });
    // The slot is free: a second Test runs.
    expect((await service(15_000).test(caller(), { scope: "global", name: "gone" })).state).toBe("failed");
  });

  it("never returns the server's stderr, even when it printed a secret before it exited", async () => {
    writeGlobal({ loud: node("console.error('sk-STDERR-SECRET-0123456789abcdef'); process.exit(1)") });
    const result = await service(15_000).test(caller(), { scope: "global", name: "loud" });
    expect(result.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("sk-STDERR-SECRET");
    expect(JSON.stringify(logs)).not.toContain("sk-STDERR-SECRET");
  });

  it("answers timeout for a server that never answers initialize, and leaves no process", async () => {
    const pidFile = join(root, "hang.pid");
    writeGlobal({
      hang: node(
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1e6)",
        pidFile,
      ),
    });
    const result = await service(DEADLINE_MS).test(caller(), { scope: "global", name: "hang" });
    expect(result).toMatchObject({ state: "timeout", tools: [], message: null });
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(1);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000 });
    await vi.waitFor(() => expect(pool.active()).toBe(0), { timeout: 10_000 });
  });

  it("refuses a project server of an untrusted project with forbidden and starts nothing, then runs it once trusted", async () => {
    const marker = join(root, "marker");
    writeFileSync(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          proj: fixture({ tools: [{ name: "p", reply: "x" }] }),
          evil: node("require('node:fs').writeFileSync(process.argv[1], 'ran')", marker),
        },
      }),
    );
    const params = { scope: "project", cwd: project } as const;
    const refused = await service(15_000)
      .test(caller(), { ...params, name: "evil" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PapError);
    expect((refused as PapError).code).toBe("forbidden");
    expect(existsSync(marker)).toBe(false);
    new ProjectTrustStore(agentDir).set(project, true);
    const trusted = await service(15_000).test(caller(), { ...params, name: "proj" });
    expect(trusted).toMatchObject({ state: "connected", tools: ["p"] });
  });

  it("asks for the step-up first: no helper runs, no process starts", async () => {
    const marker = join(root, "marker");
    writeGlobal({ evil: node("require('node:fs').writeFileSync(process.argv[1], 'ran')", marker) });
    const error = await service(15_000)
      .test(testCaller(), { scope: "global", name: "evil" })
      .catch((e: unknown) => e);
    expect((error as PapError).code).toBe("step_up_required");
    expect(pool.active()).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("gives the tested server the environment a worker gives its MCP servers: no PAP_*, no NODE_OPTIONS, no service-manager variable", async () => {
    writeGlobal({
      env: fixture(
        { envKeys: "^(PAP_|NODE_OPTIONS$|NOTIFY_SOCKET$|LISTEN_|PROBE_|PI_|FROM_)" },
        { FROM_ENTRY: "1" },
      ),
    });
    const result = await service(15_000).test(caller(), { scope: "global", name: "env" });
    expect([...result.tools].sort()).toEqual([
      "env_FROM_ENTRY",
      "env_PI_CODING_AGENT_DIR",
      "env_PI_OFFLINE",
      "env_PI_SKIP_VERSION_CHECK",
      "env_PI_TELEMETRY",
      "env_PROBE_VISIBLE",
    ]);
  });
});
