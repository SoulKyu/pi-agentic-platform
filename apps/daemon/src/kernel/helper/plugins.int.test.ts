import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Clock, createSystemClock } from "../clock.ts";
import { type LogFields, type Logger, silentLogger } from "../logger.ts";
import { createHelperPool, type HelperPool, STDIO_DRAIN_MS } from "./pool.ts";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENTRY = join(REPO, "packages/pi-host/src/helper/main.ts");
const NETWORK_GUARD = join(REPO, "packages/pi-host/src/testing/network-guard.ts");
const EXEC_ARGV = [
  "--conditions=development",
  "--disable-warning=ExperimentalWarning",
  "--import",
  NETWORK_GUARD,
];

/** The run's deadline timer is held until the test fires it (a real short deadline raced the helper's start under load). */
const HELD_DEADLINE_MS = 424_242;
const HELD = { id: -1 };
const DROPPED = { id: -2 };
function heldDeadlineClock(): { clock: Clock; fireDeadline(): void } {
  const system = createSystemClock();
  let held: (() => void) | undefined;
  return {
    clock: {
      ...system,
      setTimeout: (fn, ms) => {
        if (ms === STDIO_DRAIN_MS) return DROPPED;
        if (ms !== HELD_DEADLINE_MS) return system.setTimeout(fn, ms);
        held = fn;
        return HELD;
      },
      clearTimeout: (handle) => {
        if (handle === HELD) held = undefined;
        else if (handle !== DROPPED) system.clearTimeout(handle);
      },
    },
    fireDeadline() {
      const fn = held;
      held = undefined;
      if (!fn) throw new Error("no held deadline: the run already ended");
      fn();
    },
  };
}

let root: string;
let pool: HelperPool;
let deadlines: ReturnType<typeof heldDeadlineClock>;
let logs: Array<{ msg: string; fields: LogFields | undefined }>;
const logger: Logger = { ...silentLogger, warn: (msg, fields) => void logs.push({ msg, fields }) };

beforeEach(() => {
  deadlines = heldDeadlineClock();
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-plugins-int-")));
  for (const dir of ["agent", "pap", "home", "bin"]) mkdirSync(join(root, dir));
  // A fake `npm` whose install hangs: it records its pid and its environment, then becomes a long sleep. Files the test polls
  // for are written to a temporary name and renamed, so the test never reads one the shell created but has not filled yet.
  const npm = join(root, "bin", "npm");
  writeFileSync(
    npm,
    `#!/bin/sh\nif [ "$1" = install ]; then\n  echo $$ > "${join(root, "npm.pid")}"\n  env > "${join(root, "npm.env.tmp")}" && mv "${join(root, "npm.env.tmp")}" "${join(root, "npm.env")}"\n  if [ -f "${join(root, "detach")}" ]; then\n    setsid sleep 600 &\n    echo $! > "${join(root, "grandchild.tmp")}" && mv "${join(root, "grandchild.tmp")}" "${join(root, "grandchild.pid")}"\n    wait\n  fi\n  exec sleep 600\nfi\nexit 1\n`,
  );
  chmodSync(npm, 0o755);
  logs = [];
  pool = createHelperPool({
    entry: ENTRY,
    execArgv: EXEC_ARGV,
    baseEnv: {
      PATH: `relative${delimiter}${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      LANG: process.env.LANG,
      HOME: join(root, "home"),
      PAP_HOME: "/must/not/leak",
      PAP_SESSION_SECRET: "must-not-leak",
      NODE_OPTIONS: "--max-old-space-size=256",
      NOTIFY_SOCKET: "/run/must-not-leak",
    },
    agentDir: join(root, "agent"),
    papHome: join(root, "pap"),
    max: 2,
    clock: deadlines.clock,
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

const alive = (pid: number): boolean => {
  expect(pid).toBeGreaterThan(1);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a plugin install in a real helper", () => {
  it("hands npm the stripped environment, and a deadline kill leaves no npm process behind", async () => {
    const run = pool.run(
      "plugins.install",
      { source: "npm:@example/pi-tools@1.0.0", scope: "user" },
      { deadlineMs: HELD_DEADLINE_MS },
    );
    run.done.catch(() => {});
    await expect.poll(() => existsSync(join(root, "npm.env")), { timeout: 30_000 }).toBe(true);
    const pid = Number(readFileSync(join(root, "npm.pid"), "utf8").trim());
    expect(alive(pid)).toBe(true);

    const env = readFileSync(join(root, "npm.env"), "utf8").split("\n");
    const keys = env.map((line) => line.slice(0, line.indexOf("=")));
    expect(keys.filter((key) => key.startsWith("PAP_"))).toEqual([]);
    for (const key of ["NODE_OPTIONS", "NOTIFY_SOCKET"]) expect(keys).not.toContain(key);
    const path = env.find((line) => line.startsWith("PATH="))?.slice(5) ?? "";
    expect(path.split(delimiter).every((entry) => entry.startsWith("/"))).toBe(true);
    expect(path.split(delimiter)).toContain(join(root, "bin"));
    expect(env).toContain("PI_TELEMETRY=0");
    expect(env).toContain("GIT_TERMINAL_PROMPT=0");

    deadlines.fireDeadline();
    await expect(run.done).rejects.toMatchObject({ code: "timeout" });
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => pool.active(), { timeout: 15_000 }).toBe(0);
  });

  it("a cancel kills the helper and the npm process with it", async () => {
    const run = pool.run(
      "plugins.install",
      { source: "npm:@example/pi-tools@1.0.0", scope: "user" },
      { deadlineMs: HELD_DEADLINE_MS },
    );
    run.done.catch(() => {});
    await expect.poll(() => existsSync(join(root, "npm.pid")), { timeout: 30_000 }).toBe(true);
    const pid = Number(readFileSync(join(root, "npm.pid"), "utf8").trim());
    run.cancel();
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => pool.active(), { timeout: 15_000 }).toBe(0);
  });

  it("a deadline kill also ends what npm detached into a session of its own (Task 19's sweep)", async () => {
    writeFileSync(join(root, "detach"), "");
    const run = pool.run(
      "plugins.install",
      { source: "npm:@example/pi-tools@1.0.0", scope: "user" },
      { deadlineMs: HELD_DEADLINE_MS },
    );
    run.done.catch(() => {});
    await expect.poll(() => existsSync(join(root, "grandchild.pid")), { timeout: 30_000 }).toBe(true);
    const pid = Number(readFileSync(join(root, "npm.pid"), "utf8").trim());
    const grandchild = Number(readFileSync(join(root, "grandchild.pid"), "utf8").trim());
    expect(alive(grandchild)).toBe(true);
    deadlines.fireDeadline();
    await expect(run.done).rejects.toMatchObject({ code: "timeout" });
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => alive(grandchild), { timeout: 15_000 }).toBe(false);
  });
});
