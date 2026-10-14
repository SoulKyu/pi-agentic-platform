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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createHelperPool, type HelperPool } from "../../kernel/helper/pool.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createMcpService } from "./service.ts";

// pi-mcp starts each stdio server in a group of its own, so the pool's group signals never reach it (MC45 I1): the helper
// itself ends the servers on SIGTERM and when the pool stops. The server here ignores SIGTERM on purpose.
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/helper/main.ts");
const EXEC_ARGV = ["--conditions=development", "--disable-warning=ExperimentalWarning"];
const STUBBORN =
  "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)";

let root: string;
let pool: HelperPool;
let pidFile: string;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ppidOf = (pid: number): number =>
  Number(
    readFileSync(`/proc/${pid}/stat`, "utf8")
      .replace(/^.*\) /, "")
      .split(" ")[1],
  );
const serverPid = async (): Promise<number> => {
  await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "").toBe(true), {
    timeout: 20_000,
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(pid).toBeGreaterThan(1);
  return pid;
};
const caller = () => testCaller({ stepUpUntil: Date.now() + 600_000 });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-mcpt-clean-")));
  const agentDir = join(root, "home", ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "pap"));
  pidFile = join(root, "server.pid");
  writeFileSync(
    join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { hang: { command: process.execPath, args: ["-e", STUBBORN, pidFile] } } }),
  );
  pool = createHelperPool({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    baseEnv: { PATH: process.env.PATH, LANG: process.env.LANG, HOME: join(root, "home"), PI_OFFLINE: "1" },
    agentDir,
    papHome: join(root, "pap"),
    max: 2,
    clock: createSystemClock(),
    logger: silentLogger,
  });
});
afterEach(async () => {
  try {
    await pool.stopAll();
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const service = () =>
  createMcpService({
    helpers: pool,
    projects: { covers: () => false },
    logger: silentLogger,
    clock: createSystemClock(),
    testDeadlineMs: 60_000,
  });

describe("mcp.test: no server outlives its helper", () => {
  it("ends a server that ignores SIGTERM when the helper gets SIGTERM", async () => {
    const running = service()
      .test(caller(), { scope: "global", name: "hang" })
      .catch(() => undefined);
    const pid = await serverPid();
    const helper = ppidOf(pid);
    expect(helper).toBeGreaterThan(1);
    process.kill(helper, "SIGTERM");
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000 });
    await running;
  });

  it("leaves no server when the pool stops during a Test", async () => {
    const running = service()
      .test(caller(), { scope: "global", name: "hang" })
      .catch(() => undefined);
    const pid = await serverPid();
    await pool.stopAll();
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 15_000 });
    await running;
  });
});
