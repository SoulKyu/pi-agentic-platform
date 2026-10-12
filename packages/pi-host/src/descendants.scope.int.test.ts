import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countAgentProcesses, readBounded } from "./descendants.ts";

// A clean environment (`env -i`, a CI step) has no XDG_RUNTIME_DIR; the user manager's socket is where logind puts it.
const uid = process.getuid?.() ?? -1;
const runtimeDir = `/run/user/${uid}`;
if (!process.env.XDG_RUNTIME_DIR && existsSync(runtimeDir)) process.env.XDG_RUNTIME_DIR = runtimeDir;

const available = (() => {
  try {
    execFileSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
})();
// Containment, not a security probe: skipped locally with a reason, but CI starts a user manager and must run it (owner M2-Q8, R92).
if (!available && process.env.CI)
  throw new Error("descendants.scope.int.test: CI must provide a systemd user manager (see ci.yml)");
if (!available) console.warn("descendants.scope.int.test: skipped: no systemd user manager answers here");

// The worker: it leads a group (the daemon forks it detached), and its "shell" (detached, a group of its own, as Pi's
// bash tool starts it) starts `sleep` and exits, which is what
// `cmd &` does in Pi's bash tool: the sleep is left to pid 1 (or the user manager) and is no descendant any more.
const STAND_IN = `
const { spawn } = require("node:child_process");
spawn("sh", ["-c", "sleep 300 >/dev/null 2>&1 &"], { stdio: "ignore", detached: true });
setInterval(() => {}, 1000);
`;

let unit = "";
let worker: ChildProcess | null = null;
afterEach(() => {
  if (!unit) return;
  try {
    execFileSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 10_000 });
  } catch {
    // never started, or already gone
  }
  unit = "";
  worker = null;
});

describe.runIf(available && process.platform === "linux")("countAgentProcesses in a scope of pap's", () => {
  it("counts what the agent's shell left running, which is no descendant of the worker (M2-RT-14)", async () => {
    unit = `pap-test-worker-${randomBytes(4).toString("hex")}-1.scope`;
    const named = unit;
    worker = spawn(
      "systemd-run",
      ["--user", "--scope", "--quiet", `--unit=${unit}`, "--", process.execPath, "-e", STAND_IN],
      { stdio: "ignore", detached: true },
    );
    const pid = worker.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    // This test's own /proc/self/cgroup is not the worker's: the worker's is read instead.
    const readFile = (path: string, max: number) =>
      readBounded(path === "/proc/self/cgroup" ? `/proc/${pid}/cgroup` : path, max);
    await vi.waitFor(
      () => expect(countAgentProcesses({ pid, readFile, unit: named, token: undefined })).toBe(1),
      { timeout: 10_000 },
    );
    // Without the scope it is not found: the sleep is not below the worker, and no marker is set here.
    expect(countAgentProcesses({ pid, readFile: () => null, unit: named, token: undefined })).toBe(0);
  });
});
