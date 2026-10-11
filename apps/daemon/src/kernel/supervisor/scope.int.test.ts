import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../clock.ts";
import { createLogger } from "../logger.ts";
import { alive, createRogueBed, realPid, type RogueBed, waitForReady } from "../testing/rogue-bed.ts";
import type { WorkerHandle } from "./worker.ts";
import { execFileCode, execFileText, whichOnPath } from "../which.ts";
import type { WorkerExit } from "./exit.ts";
import { probeScopes, type ScopeLimits, type WorkerScope, type WorkerScopes } from "./scope.ts";

// A clean environment (`env -i`, a CI step) has no XDG_RUNTIME_DIR; the user manager's socket is where logind puts it.
const runtimeDir = `/run/user/${process.getuid?.() ?? -1}`;
if (!process.env.XDG_RUNTIME_DIR && existsSync(runtimeDir)) process.env.XDG_RUNTIME_DIR = runtimeDir;

const available = (() => {
  try {
    const linger = execFileSync(
      "loginctl",
      ["show-user", String(process.getuid?.() ?? -1), "--property=Linger", "--value"],
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return linger === "yes";
  } catch {
    return false;
  }
})();
// Containment, not a security probe: skipped locally with a reason, but CI starts a user manager and must run it (owner M2-Q8, R92).
if (!available && process.env.CI)
  throw new Error("scope.int.test: CI must provide a lingering systemd user manager (see ci.yml)");
if (!available)
  console.warn("scope.int.test: skipped: no lingering systemd user manager answers on this machine");

// A slice of the test's own (a temporary PAP_HOME): never the owner's daemon slice.
let home: string;
let probed: WorkerScopes[] = [];
let logged: Array<Record<string, unknown>> = [];
const scopesWith = async (limits: ScopeLimits): Promise<WorkerScopes> => {
  const scopes = await probeScopes(
    "auto",
    { ...limits, memorySwapMaxMb: 0 },
    {
      home,
      uid: process.getuid?.() ?? -1,
      exec: execFileText,
      execSync: execFileCode,
      env: process.env,
      which: (command) => whichOnPath(command, process.env),
      clock: createSystemClock(),
      logger: createLogger({
        level: "debug",
        clock: createSystemClock(),
        write: (line) => void logged.push(JSON.parse(line) as Record<string, unknown>),
      }),
    },
  );
  probed.push(scopes);
  return scopes;
};
// The bed's clock is fake: the ladder's first rung (2 s) is advanced by hand, and the rogue worker ends on its SIGTERM.
const stopped = async (handle: WorkerHandle) => {
  const pending = handle.stop();
  await bed.clock.advance(2000);
  return pending;
};
const sliceOf = (scope: WorkerScope) =>
  scope.launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length) ?? "";
// A deadline on the exit report: a reap that hangs fails the test instead of the run.
const exitOf = async (handle: WorkerHandle): Promise<WorkerExit> => {
  let exit: WorkerExit | undefined;
  void handle.exited.then((reported) => (exit = reported));
  await vi.waitFor(() => expect(exit).toBeDefined(), { timeout: 10_000 });
  return exit as WorkerExit;
};
const pgrpOf = (pid: number) =>
  Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ")[2]);
const scopeOf = (scopes: WorkerScopes) => {
  const next = scopes.next();
  if (!next) throw new Error("no scope");
  return next;
};

let bed: RogueBed;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-scope-home-"));
  bed = createRogueBed();
  probed = [];
  logged = [];
});
afterEach(async () => {
  try {
    await bed.dispose();
  } finally {
    try {
      // Only slices of this test's own home: the hash comes from the temporary directory.
      await Promise.all(probed.map((scopes) => scopes.sweep()));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe.skipIf(!available)("workers in systemd user scopes", () => {
  it("runs a worker in a unit of its home's slice with MemoryMax, leading its own process group (R106)", async () => {
    const scopes = await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 });
    const scope = scopeOf(scopes);
    const handle = bed.rogue("echo", { scope });
    await waitForReady(bed.collect(handle));
    const pid = realPid(handle.pid);
    expect(pgrpOf(pid)).toBe(pid);
    expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toContain(
      `${scopes.slice}/${sliceOf(scope)}/${scope.unit}`,
    );
    const max = execFileSync("systemctl", ["--user", "show", scope.unit, "--property=MemoryMax", "--value"], {
      encoding: "utf8",
    }).trim();
    expect(max).toBe(String(2048 * 1024 * 1024));
    expect((await stopped(handle)).cause).toBe("signal");
  });

  it("stops the scope after the worker dies, so what it started in a group of its own dies too (R100)", async () => {
    const scope = scopeOf(await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 }));
    const handle = bed.rogue("setsid-child", { scope });
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    process.kill(realPid(handle.pid), "SIGKILL");
    expect((await exitOf(handle)).cause).toBe("killed");
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 5000 });
  });

  it("says out of memory when the scope's limit kills the worker itself", async () => {
    const handle = bed.rogue("hog", { scope: scopeOf(await scopesWith({ memoryMaxMb: 128, tasksMax: 64 })) });
    expect((await exitOf(handle)).cause).toBe("oom");
  });

  it("keeps the worker when the limit kills a child it started (OOMPolicy=continue, owner R2-1)", async () => {
    const handle = bed.rogue("child-hog", {
      scope: scopeOf(await scopesWith({ memoryMaxMb: 256, tasksMax: 64 })),
    });
    const records = bed.collect(handle);
    await vi.waitFor(
      () =>
        expect(
          records.some(
            (r) => r.type === "extension_error" && r.event === "child_exit" && r.error === "SIGKILL",
          ),
        ).toBe(true),
      { timeout: 20_000 },
    );
    expect(alive(realPid(handle.pid))).toBe(true);
    // The rogue worker ignores `shutdown`: the ladder's SIGTERM ends it, and its exit is that signal, not memory.
    expect((await stopped(handle)).cause).toBe("signal");
  });

  it("sweeps what an earlier daemon of the same home left in its slice", async () => {
    const scopes = await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 });
    const handle = bed.rogue("setsid-child", { scope: scopeOf(scopes) });
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    await (await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 })).sweep();
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 5000 });
    await exitOf(handle);
  });

  it("kills the whole slice at once, children slices included, on a forced exit", async () => {
    const scopes = await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 });
    const handle = bed.rogue("setsid-child", { scope: scopeOf(scopes) });
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    scopes.killAllNow();
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 5000 });
    expect((await exitOf(handle)).cause).toBe("killed");
  });

  it("SIGKILLs a group of its own that ignores SIGTERM when the worker dies (R100), without waiting for the stop timeout", async () => {
    const scope = scopeOf(await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 }));
    const handle = bed.rogue("term-proof-child", { scope });
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    process.kill(realPid(handle.pid), "SIGKILL");
    // TimeoutStopSec is 5 s: only the unit's SIGKILL step ends it sooner.
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 2500 });
    expect((await exitOf(handle)).cause).toBe("killed");
  });

  it("does not call a worker's SIGKILL out of memory because a sibling's child was (own slice per worker)", async () => {
    const scopes = await scopesWith({ memoryMaxMb: 256, tasksMax: 64 });
    const sibling = bed.rogue("child-hog", { scope: scopeOf(scopes) });
    const siblingRecords = bed.collect(sibling);
    const worker = bed.rogue("echo", { scope: scopeOf(scopes) });
    await waitForReady(bed.collect(worker));
    await vi.waitFor(
      () =>
        expect(siblingRecords.some((r) => r.type === "extension_error" && r.error === "SIGKILL")).toBe(true),
      { timeout: 20_000 },
    );
    process.kill(realPid(worker.pid), "SIGKILL");
    expect((await exitOf(worker)).cause).toBe("killed");
  });

  it("logs nothing of the scope steps for a normal exit, and leaves no unit nor slice of the worker", async () => {
    const scopes = await scopesWith({ memoryMaxMb: 2048, tasksMax: 4096 });
    const scope = scopeOf(scopes);
    const handle = bed.rogue("echo", { scope });
    await waitForReady(bed.collect(handle));
    expect((await stopped(handle)).cause).toBe("signal");
    expect(logged.filter((line) => String(line.msg).startsWith("worker_scope_"))).toEqual([]);
    const left = execFileSync(
      "systemctl",
      ["--user", "list-units", "--all", "--no-legend", scope.unit, sliceOf(scope)],
      { encoding: "utf8" },
    );
    expect(left).not.toMatch(/\bactive\b/);
  });
});
