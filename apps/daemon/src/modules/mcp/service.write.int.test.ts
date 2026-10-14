import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createHelperPool, type HelperPool } from "../../kernel/helper/pool.ts";
import { silentLogger } from "../../kernel/logger.ts";
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

let root: string;
let agentDir: string;
let project: string;
let pool: HelperPool;
const clock = createFakeClock();
const owner = () => testCaller({ stepUpUntil: clock.now() + 60_000 });
const service = () =>
  createMcpService({
    helpers: pool,
    projects: { covers: (_o, cwd) => cwd.startsWith(project) },
    logger: silentLogger,
    clock,
  });
const text = (servers: Record<string, unknown>) => `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
const SERVERS = { alpha: { command: "a", env: { K: "lit" } }, beta: { url: "https://h.example/mcp" } };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-mcp-write-int-")));
  agentDir = join(root, "home", ".pi", "agent");
  project = join(root, "home", "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  mkdirSync(join(root, "pap"));
  writeFileSync(join(agentDir, "mcp.json"), text(SERVERS));
  pool = createHelperPool({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    baseEnv: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
    agentDir,
    papHome: join(root, "pap"),
    max: 2,
    clock: createFakeClock(),
    logger: silentLogger,
  });
});
afterEach(async () => {
  try {
    await pool.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("mcp writes through a real helper", () => {
  it("switches a server off and on, and removes then restores it byte for byte", async () => {
    const file = join(agentDir, "mcp.json");
    const svc = service();
    expect(
      await svc.setEnabled(owner(), { servers: [{ scope: "global", name: "beta" }], enabled: false }),
    ).toEqual({
      results: [{ scope: "global", name: "beta", ok: true }],
    });
    expect((await svc.overview(owner())).global.servers.find((s) => s.name === "beta")?.state).toBe(
      "disabled",
    );
    await svc.setEnabled(owner(), { servers: [{ scope: "global", name: "beta" }], enabled: true });
    expect(readFileSync(file, "utf8")).toBe(text(SERVERS));
    const { token } = await svc.remove(owner(), { scope: "global", name: "alpha" });
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).mcpServers)).toEqual(["beta"]);
    await svc.undo(owner(), { token });
    expect(readFileSync(file, "utf8")).toBe(text(SERVERS));
  });

  it("adds a global entry with a step-up, 0600, and refuses a second add of the name", async () => {
    const svc = service();
    await expect(
      svc.add(testCaller(), { scope: "global", name: "n", entry: { command: "x" } }),
    ).rejects.toEqual(new PapError("step_up_required"));
    await svc.add(owner(), { scope: "global", name: "n", entry: { command: "x" } });
    expect(statSync(join(agentDir, "mcp.json")).mode & 0o777).toBe(0o600);
    await expect(svc.add(owner(), { scope: "global", name: "n", entry: { command: "y" } })).rejects.toEqual(
      new PapError("conflict"),
    );
  });

  it("writes a project file only for a trusted project and a confirmed save", async () => {
    const svc = service();
    const params = { name: "alpha", enabled: false, cwd: project };
    await expect(svc.setInProject(owner(), params)).rejects.toEqual(new PapError("protected_path"));
    await expect(svc.setInProject(owner(), { ...params, confirmProtected: true })).rejects.toEqual(
      new PapError("forbidden"),
    );
    new ProjectTrustStore(agentDir).set(project, true);
    await svc.setInProject(owner(), { ...params, confirmProtected: true });
    expect(readFileSync(join(project, ".pi", "mcp.json"), "utf8")).toBe(text({ alpha: { enabled: false } }));
    expect((await svc.overview(owner(), project)).global.servers.find((s) => s.name === "alpha")?.state).toBe(
      "overridden",
    );
  });

  it("edits the code mode keys of settings.json and answers the new state", async () => {
    const svc = service();
    expect(await svc.setCodemode(owner(), { choice: "always", mode: "only", inlineBudget: 500 })).toEqual({
      choice: "always",
      mode: "only",
      inlineBudget: 500,
    });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
      defaultTools: ["+codemode"],
      codemode: { mode: "only", inlineBudget: 500 },
    });
    expect(await svc.setCodemode(owner(), { choice: "automatic", mode: "on", inlineBudget: null })).toEqual({
      choice: "automatic",
      mode: "on",
      inlineBudget: null,
    });
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({});
  });
});
