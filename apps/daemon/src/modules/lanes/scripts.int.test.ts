import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { LINUX_PROBE, procTag } from "./script-orphans.ts";
import { spawnScript } from "./script-spawn.ts";
import { createScriptStore } from "./script-store.ts";
import { createScriptRunner, type ScriptRunnerDeps } from "./scripts.ts";
import { insertLane } from "./testing/lane-rows.ts";
import { tempHome } from "./testing/script-fakes.ts";

let db: Db;
let home: ReturnType<typeof tempHome>;
const clock = createSystemClock();
const logs = captureLogger();

beforeEach(() => {
  home = tempHome();
  db = migrate({
    dbPath: join(home.dir, "state.db"),
    backupsDir: join(home.dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock,
    logger: logs.logger,
  }).db;
});
afterEach(() => {
  db.close();
  home.dispose();
});

const runnerWith = (text: string, extra: Partial<ScriptRunnerDeps> = {}) =>
  createScriptRunner({
    store: createScriptStore(db),
    clock,
    logger: logs.logger,
    home: join(home.dir, "pap"),
    // A literal, hostile environment: the runner never sees process.env.
    env: {
      HOME: home.dir,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/tmp/agent",
      GIT_DIR: "/tmp/nowhere",
      PAP_HOME: "/tmp/pap-home",
      PAP_SECRET: "s",
      ANTHROPIC_API_KEY: "k",
    },
    umask: 0o022,
    scopes: { next: () => null },
    approved: async () => ({ ok: true, text }),
    spawn: spawnScript(clock),
    probe: LINUX_PROBE,
    readOnly: false,
    ...extra,
  });

const lane = () => {
  const worktree = join(home.dir, "wt");
  mkdirSync(worktree, { recursive: true });
  return insertLane(db, { worktree, projectRoot: join(home.dir, "project") });
};
const stateOf = (runner: ReturnType<typeof runnerWith>, id: string) => runner.state(id, "setup").state;
/** The pids whose process group is `pgid` (zombies included), from /proc: nothing else is trusted to say. */
const groupMembers = (pgid: number): string => {
  const members: string[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2] === String(pgid)) members.push(name);
    } catch {
      // the process ended between the listing and the read
    }
  }
  return members.join("\n");
};

describe("ScriptRunner with real processes (scopes off)", () => {
  it("writes the log, creates files under umask 022, and shows only the allowlisted environment", async () => {
    const l = lane();
    const runner = runnerWith("echo umask=$(umask); touch made; env");
    expect(await runner.run(l, "setup")).toEqual({ ok: true });
    await vi.waitFor(() => expect(stateOf(runner, l.id)).toBe("ok"), { timeout: 10_000 });
    const log = readFileSync(join(home.dir, "pap", "lanes", l.id, "setup.log"), "utf8");
    expect(log).toContain("umask=0022");
    expect(statSync(join(l.worktree, "made")).mode & 0o777).toBe(0o644);
    expect(log).toContain(`PAP_LANE_ID=${l.id}`);
    expect(log).toContain(`PAP_LANE_ROOT=${l.projectRoot}`);
    expect(log).toContain(`PAP_LANE_WORKTREE=${l.worktree}`);
    expect(log).toContain("TERM=dumb");
    for (const absent of ["SSH_AUTH_SOCK", "GIT_DIR", "PAP_HOME", "PAP_SECRET", "ANTHROPIC_API_KEY"])
      expect(log, absent).not.toContain(absent);
    expect(statSync(join(home.dir, "pap", "lanes", l.id, "setup.log")).mode & 0o777).toBe(0o600);
    expect(runner.readLog("u1", l.id, "setup", 0).text).toBe(log);
  });

  it("stops at the first failing command (bash -e) and records the exit code", async () => {
    const l = lane();
    const runner = runnerWith("false; touch not-reached");
    await runner.run(l, "setup");
    await vi.waitFor(() => expect(stateOf(runner, l.id)).toBe("failed"), { timeout: 10_000 });
    expect(runner.state(l.id, "setup").exitCode).toBe(1);
    expect(existsSync(join(l.worktree, "not-reached"))).toBe(false);
  });

  it("leaves no process in the group of a script that traps TERM, after an injected 200 ms deadline", async () => {
    const l = lane();
    const runner = runnerWith("(trap '' TERM; sleep 30) & sleep 30", {
      deadlines: { setup: 200 },
      termGraceMs: 300,
    });
    await runner.run(l, "setup");
    const pgid =
      db.get<{ script_pgid: number }>("SELECT script_pgid FROM lanes WHERE id = $id", {
        id: l.id,
      })?.script_pgid ?? 0;
    expect(pgid).toBeGreaterThan(1);
    await vi.waitFor(() => expect(groupMembers(pgid)).not.toBe(""), { timeout: 5000 });
    await vi.waitFor(() => expect(stateOf(runner, l.id)).toBe("failed"), { timeout: 10_000 });
    expect(runner.state(l.id, "setup").exitCode).toBeNull();
    await vi.waitFor(() => expect(groupMembers(pgid)).toBe(""), { timeout: 10_000 });
  });

  it("kills an orphan group a crash left, at recover(), and spawns nothing", async () => {
    const l = lane();
    const orphan = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    const pgid = orphan.pid ?? 0;
    expect(pgid).toBeGreaterThan(1);
    const tag = procTag(LINUX_PROBE, pgid) ?? "";
    db.run(
      "UPDATE lanes SET setup_state = 'running', script_pgid = $pgid, script_proc = $tag WHERE id = $id",
      {
        id: l.id,
        pgid,
        tag,
      },
    );
    const fresh = runnerWith("echo never");
    await fresh.recover();
    await once(orphan, "exit");
    expect(groupMembers(pgid)).toBe("");
    expect(stateOf(fresh, l.id)).toBe("interrupted");
    expect(existsSync(join(home.dir, "pap", "lanes", l.id))).toBe(false);
  });
});
