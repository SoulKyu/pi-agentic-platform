import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { maskedStdio } from "../../kernel/pty/fd-mask.ts";
import {
  killAllWorkerGroups,
  releaseGroup,
  signalGroup,
  trackGroup,
} from "../../kernel/supervisor/process-group.ts";
import {
  type PrecheckDeps,
  type PrecheckGroups,
  type PrecheckOutcome,
  precheckEnv,
  precheckSpec,
  runPrecheck,
} from "./precheck.ts";

const WAIT = { timeout: 10_000, interval: 25 } as const;
const clock = createSystemClock();
let dir: string;
let tracked: Set<number>;
let released: number[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-precheck-")));
  tracked = new Set();
  released = [];
});
afterEach(() => {
  for (const pid of tracked) signalGroup(pid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const groups: PrecheckGroups = {
  track: (pid) => {
    tracked.add(pid);
    trackGroup(pid);
  },
  signal: (pid, signal) => void signalGroup(pid, signal),
  release: (pid) => {
    released.push(pid);
    releaseGroup(pid);
  },
};
const deps = (): PrecheckDeps => ({
  spawn,
  stdio: () => maskedStdio(["pipe", "pipe", "pipe"]),
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = clock.setTimeout(fn, ms);
    return { cancel: () => clock.clearTimeout(handle) };
  },
  groups,
});
const DAEMON_ENV = {
  PATH: process.env.PATH,
  KUBECONFIG: "/kube/config",
  ANTHROPIC_API_KEY: "sk-secret",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  GH_TOKEN: "ghp-secret",
};
const run = (
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; names?: string[] } = {},
): Promise<PrecheckOutcome> =>
  runPrecheck(
    precheckSpec(command, precheckEnv({ ...DAEMON_ENV, HOME: dir }, options.names ?? []), null),
    options.cwd ?? dir,
    deps(),
    { timeoutMs: options.timeoutMs, signal: options.signal },
  );

const alive = (pid: number): boolean => {
  try {
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
};
const pidFrom = (file: string): number => Number(readFileSync(join(dir, file), "utf8").trim());
const HOLDING = (file: string) => `trap '' TERM; sleep 60 & echo $! > ${file}; while :; do sleep 0.05; done`;

describe("runPrecheck on a real /bin/sh (M10R69, M10R70)", () => {
  it("fires with the folder and only the allowed environment", async () => {
    const outcome = await run(
      "pwd; echo K=$KUBECONFIG A=${ANTHROPIC_API_KEY:-none} S=${SSH_AUTH_SOCK:-none} G=${GH_TOKEN:-none}",
      { names: ["KUBECONFIG", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "GH_TOKEN"] },
    );
    expect(outcome.verdict).toBe("fire");
    const output = outcome.verdict === "fire" ? outcome.output : "";
    expect(output).toContain(dir);
    expect(output).toContain("K=/kube/config A=none S=none G=none");
  });

  it("skips on exit 1 with the stripped first line as the reason", async () => {
    const outcome = await run("printf '\\342\\200\\256nothing new\\n'; exit 1");
    expect(outcome).toMatchObject({ verdict: "skip", reason: "nothing new" });
  });

  it("answers an error for any other exit code", async () => {
    expect(await run("exit 7")).toMatchObject({ verdict: "error", code: "exit", exitCode: 7 });
  });

  it("closes stdin: a read sees end of file", async () => {
    expect(await run("read line || exit 1")).toMatchObject({ verdict: "skip" });
  });

  it("answers a signal when the shell is killed by one", async () => {
    expect(await run("kill -9 $$")).toMatchObject({ verdict: "error", code: "signal" });
  });

  it("keeps exactly the last 4096 bytes of 100 000", async () => {
    const outcome = await run("head -c 100000 /dev/zero | tr '\\0' 'a'; echo last");
    const output = outcome.verdict === "fire" ? outcome.output : "";
    expect(Buffer.byteLength(output)).toBe(4096);
    expect(output.endsWith("last\n")).toBe(true);
  });

  it("times out a shell that ignores SIGTERM, kills its group and its job", async () => {
    const started = Date.now();
    const outcome = await run(HOLDING("job.pid"), { timeoutMs: 300 });
    expect(outcome).toMatchObject({ verdict: "error", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
    const job = pidFrom("job.pid");
    await vi.waitFor(() => expect(alive(job)).toBe(false), WAIT);
  });

  it("aborts the same command through the signal, and never spawns for one that is already aborted", async () => {
    const controller = new AbortController();
    const pending = run(HOLDING("abort.pid"), { signal: controller.signal });
    await vi.waitFor(() => expect(pidFrom("abort.pid")).toBeGreaterThan(1), WAIT);
    controller.abort();
    expect(await pending).toMatchObject({ verdict: "error", code: "aborted" });
    await vi.waitFor(() => expect(alive(pidFrom("abort.pid"))).toBe(false), WAIT);
    const before = tracked.size;
    expect(await run("touch never-ran", { signal: AbortSignal.abort() })).toMatchObject({ code: "aborted" });
    expect(tracked.size).toBe(before);
    expect(() => readFileSync(join(dir, "never-ran"))).toThrow();
  });

  it("is reached by killAllWorkerGroups() while it runs", async () => {
    const pending = run("sleep 60 & echo $! > kill.pid; wait");
    await vi.waitFor(() => expect(pidFrom("kill.pid")).toBeGreaterThan(1), WAIT);
    expect(killAllWorkerGroups()).toBeGreaterThanOrEqual(1);
    expect(await pending).toMatchObject({ verdict: "error" });
    await vi.waitFor(() => expect(alive(pidFrom("kill.pid"))).toBe(false), WAIT);
  });

  it("kills a job the shell left behind with & when it exits", async () => {
    const started = Date.now();
    const outcome = await run("sleep 60 & echo $! > left.pid; exit 0");
    expect(outcome.verdict).toBe("fire");
    expect(Date.now() - started).toBeLessThan(3000);
    await vi.waitFor(() => expect(alive(pidFrom("left.pid"))).toBe(false), WAIT);
  });

  it("releases every tracked group, and answers spawn for a missing folder", async () => {
    await run("exit 0");
    await run("exit 1");
    expect(await run("exit 0", { cwd: join(dir, "missing") })).toMatchObject({
      verdict: "error",
      code: "spawn",
    });
    expect([...tracked].sort()).toEqual([...released].sort());
    expect(killAllWorkerGroups()).toBe(0);
  });
});
