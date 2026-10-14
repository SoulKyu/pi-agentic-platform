import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSystemClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import { shellEnv } from "../pty/env.ts";
import { ptyKill } from "../pty/kill.ts";
import { loadNodePty } from "../pty/load.ts";
import { ptySpec, spawnPty, type PtyProcess } from "../pty/spawn.ts";
import { createHelperPool, type HelperPool } from "./pool.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/helper/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");

let root: string;
let pool: HelperPool;
let terminal: PtyProcess | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-helper-pty-"));
  pool = createHelperPool({
    entry: ENTRY,
    execArgv: [
      "--conditions=development",
      "--disable-warning=ExperimentalWarning",
      "--import",
      NETWORK_GUARD,
    ],
    baseEnv: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1" },
    agentDir: join(root, "agent"),
    papHome: join(root, "pap"),
    extraEnv: { PAP_TEST_PROVIDER: "1" },
    max: 2,
    clock: createSystemClock(),
    logger: silentLogger,
  });
});
afterEach(async () => {
  try {
    await pool.stopAll();
    if (terminal) await ptyKill(terminal, { clock: createSystemClock(), warn: () => {} });
  } finally {
    terminal = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

/** MC29 (M8) for M7's helper: the daemon's terminals' masters are inherited by every child it forks. */
describe("a helper forked while a terminal is open", () => {
  it("holds no /dev/ptmx and no /dev/pts/* descriptor", async () => {
    const node = loadNodePty(silentLogger);
    if (node === null) throw new Error("node-pty did not load");
    const env = shellEnv({ PATH: process.env.PATH, HOME: root, SHELL: "/bin/sh" });
    terminal = spawnPty(
      node,
      ptySpec({ shell: "/bin/sh", cwd: root, cols: 80, rows: 24, env, scope: null, umask: 0o022 }),
      silentLogger,
    );
    const { links } = (await pool.run("test.fds", {}, { deadlineMs: 30_000 }).done) as { links: string[] };
    expect(links.length, "control: the helper listed its descriptors").toBeGreaterThan(2);
    expect(links.filter((link) => link === "/dev/ptmx" || link.startsWith("/dev/pts/"))).toEqual([]);
  });
});
