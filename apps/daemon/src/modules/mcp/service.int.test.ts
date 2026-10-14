import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createHelperPool, type HelperPool } from "../../kernel/helper/pool.ts";
import { type LogFields, type Logger, silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createMcpService } from "./service.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/helper/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];
const SECRETS = ["sk-ENV-LITERAL-1", "Bearer HEADER-LITERAL-2", "CLIENT-SECRET-LITERAL-3"];

let root: string;
let agentDir: string;
let project: string;
let pool: HelperPool;
let logs: Array<{ msg: string; fields: LogFields | undefined }>;
const logger: Logger = { ...silentLogger, warn: (msg, fields) => void logs.push({ msg, fields }) };
const service = () =>
  createMcpService({
    helpers: pool,
    projects: { covers: (_o, cwd) => cwd.startsWith(project) },
    logger,
    clock: createSystemClock(),
  });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-mcp-int-")));
  agentDir = join(root, "home", ".pi", "agent");
  project = join(root, "home", "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(root, "pap"));
  writeFileSync(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        spawner: { command: "touch", args: [join(root, "marker")], env: { API_KEY: SECRETS[0] } },
        remote: {
          url: "https://h.example/mcp",
          headers: { Authorization: SECRETS[1] },
          oauth: { clientSecret: SECRETS[2] },
        },
      },
    }),
  );
  logs = [];
  pool = createHelperPool({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    baseEnv: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
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

describe("mcp.overview through a real helper", () => {
  it("lists the global servers by name, without a value anywhere, and starts nothing", async () => {
    const overview = await service().overview(testCaller());
    expect(overview.global.servers.map((s) => [s.name, s.kind, s.state])).toEqual([
      ["spawner", "stdio", "on"],
      ["remote", "http", "on"],
    ]);
    expect(overview.project).toBeNull();
    for (const secret of SECRETS) expect(JSON.stringify(overview)).not.toContain(secret);
    expect(existsSync(join(root, "marker"))).toBe(false);
  });

  it("reads the project file of a trusted folder, and lists an untrusted one as not-trusted", async () => {
    writeFileSync(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { remote: { enabled: false } } }),
    );
    const untrusted = await service().overview(testCaller(), project);
    expect(untrusted.project).toMatchObject({ trusted: false });
    expect(untrusted.project?.servers[0]).toMatchObject({ name: "remote", state: "not-trusted" });
    expect(untrusted.global.servers.find((s) => s.name === "remote")?.state).toBe("on");
    new ProjectTrustStore(agentDir).set(project, true);
    const trusted = await service().overview(testCaller(), project);
    expect(trusted.global.servers.find((s) => s.name === "remote")).toMatchObject({
      state: "overridden",
      enabled: false,
    });
  });

  it("answers link-outside for a project file that is a link out of the folder", async () => {
    writeFileSync(join(root, "elsewhere.json"), JSON.stringify({ mcpServers: { leak: { command: "x" } } }));
    symlinkSync(join(root, "elsewhere.json"), join(project, ".pi", "mcp.json"));
    const overview = await service().overview(testCaller(), project);
    expect(overview.project).toMatchObject({ problem: "link-outside", servers: [] });
  });
});
