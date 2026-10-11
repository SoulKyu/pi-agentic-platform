import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alive,
  createRogueBed,
  eventsOf,
  rejection,
  type RogueBed,
  signalGroupOf,
  waitForReady,
} from "../testing/rogue-bed.ts";
import { WORKER_SHUTDOWN_GRACE_MS } from "./kill-ladder.ts";
import { killAllWorkerGroups, MAX_SHUTDOWN_GRACE_MS, spawnWorker } from "./worker.ts";

let bed: RogueBed;
beforeEach(() => {
  bed = createRogueBed();
});
afterEach(() => bed.dispose());

const echoes = (records: ReturnType<RogueBed["collect"]>) => eventsOf(records, "echo").map((e) => e.record);

describe("a worker that will not stop", () => {
  it("is escalated to SIGTERM on the group, then SIGKILL, and its whole group dies", async () => {
    const handle = bed.rogue("stubborn");
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    expect(alive(sleeper)).toBe(true);
    const stopped = handle.stop();
    await bed.clock.advance(2000);
    await vi.waitFor(() => expect(echoes(records)).toHaveLength(1));
    expect(echoes(records)[0]).toEqual({ type: "shutdown", graceMs: WORKER_SHUTDOWN_GRACE_MS });
    expect(handle.pid !== undefined && alive(handle.pid)).toBe(true);
    await bed.clock.advance(3000);
    expect(await stopped).toMatchObject({ signal: "SIGKILL", cause: "killed" });
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false));
  });

  it("asks the worker for less grace than the ladder waits for it", () => {
    expect(WORKER_SHUTDOWN_GRACE_MS).toBe(1500);
  });

  it("is killed when it is stopped by SIGSTOP and cannot even read the shutdown", async () => {
    const handle = bed.rogue("echo");
    await waitForReady(bed.collect(handle));
    signalGroupOf(handle, "SIGSTOP");
    const stopped = handle.stop();
    await bed.clock.advance(2000);
    await bed.clock.advance(3000);
    expect((await stopped).cause).toBe("killed");
  });

  it("is taken down when it closes the channel and stays alive", async () => {
    const handle = bed.rogue("disconnect");
    const records = bed.collect(handle);
    await waitForReady(records);
    await vi.waitFor(() => expect(handle.send({ type: "get_state", id: "x" })).toBe(false));
    expect(await rejection(handle.request({ type: "get_state" }))).toBe("worker_failed");
    await bed.clock.advance(2000);
    expect(await handle.exited).toMatchObject({ signal: "SIGTERM", cause: "signal" });
  });

  it("has what it left behind swept when it exits on its own", async () => {
    const handle = bed.rogue("orphan-maker");
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    expect(alive(sleeper)).toBe(true);
    expect((await handle.stop()).cause).toBe("clean");
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false));
  });

  it("never asks the worker for more than 30 s of grace", async () => {
    const handle = bed.rogue("echo");
    const records = bed.collect(handle);
    await waitForReady(records);
    handle.send({ type: "shutdown", graceMs: 10 ** 9 });
    await vi.waitFor(() => expect(echoes(records)).toHaveLength(1));
    expect(echoes(records)[0]).toEqual({ type: "shutdown", graceMs: MAX_SHUTDOWN_GRACE_MS });
    void handle.stop();
    await bed.clock.advance(2000);
    await handle.exited;
  });
});

describe("what the group kills do not reach", () => {
  // Pi's bash tool starts every command with `detached: true`: the command leads a session and a group of its
  // own, so no signal to the worker's group touches it. pi-host kills those itself when it ends; if it is killed
  // outright (SIGKILL, OOM) only the cgroup of the systemd scope (M2) covers them.
  it("leaves a child that leads a group of its own alive when the worker is killed", async () => {
    const handle = bed.rogue("setsid-child");
    const records = bed.collect(handle);
    await waitForReady(records);
    const detached = await bed.grandchildOf(records);
    const stopped = handle.stop();
    await bed.clock.advance(2000);
    expect((await stopped).cause).toBe("signal");
    expect(killAllWorkerGroups()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(detached)).toBe(true);
  });

  it("kills the group of every live worker on request, for the daemon's signal handlers", async () => {
    const handle = bed.rogue("stubborn");
    const records = bed.collect(handle);
    await waitForReady(records);
    const sleeper = await bed.grandchildOf(records);
    expect(killAllWorkerGroups()).toBe(1);
    expect(await handle.exited).toMatchObject({ signal: "SIGKILL", cause: "killed" });
    await vi.waitFor(() => expect(alive(sleeper)).toBe(false));
    expect(killAllWorkerGroups()).toBe(0);
  });
});

describe("a worker that cannot start", () => {
  it("reports a spawn failure when its directory does not exist", async () => {
    const handle = bed.rogue("echo", { cwd: join(bed.root, "missing") });
    expect(await handle.exited).toMatchObject({ cause: "spawn_failure", code: null, signal: null });
    expect(handle.send({ type: "get_state", id: "x" })).toBe(false);
    expect(await rejection(handle.request({ type: "get_state" }))).toBe("worker_failed");
    expect((await handle.stop()).cause).toBe("spawn_failure");
  });

  it("reports a spawn failure instead of throwing when the options are unusable", async () => {
    const handle = spawnWorker({
      entry: join(bed.root, "rogue.mjs"),
      execArgv: [],
      cwd: bed.root,
      env: { BAD: "a\0b" },
      clock: bed.clock,
      logger: bed.logger(),
    });
    expect(await handle.exited).toMatchObject({ cause: "spawn_failure" });
    expect(handle.pid).toBeUndefined();
    expect(bed.logged.map((entry) => entry.msg)).toContain("worker_spawn_failed");
  });

  it("reports the exit code of an entry that cannot be loaded", async () => {
    const handle = spawnWorker({
      entry: join(bed.root, "absent.mjs"),
      execArgv: [],
      cwd: bed.root,
      env: { PATH: process.env.PATH },
      clock: bed.clock,
      logger: bed.logger(),
    });
    expect(await handle.exited).toMatchObject({ code: 1, cause: "exit_code" });
    expect(handle.outputTail()).toContain("absent.mjs");
  });
});

describe("a daemon that dies", () => {
  // The daemon-like parent starts a stubborn worker (with a child in its group) and reports both pids.
  async function startParent(options: { onSigterm: "none" | "kill-all" | "exit-at-ready" }) {
    const supervisor = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const script = join(bed.root, "parent.mjs");
    writeFileSync(
      script,
      `import { killAllWorkerGroups, spawnWorker } from ${JSON.stringify(supervisor)};
const handle = spawnWorker({ entry: ${JSON.stringify(join(bed.root, "rogue.mjs"))}, execArgv: [], cwd: ${JSON.stringify(bed.root)}, env: { PATH: process.env.PATH, ROGUE: "stubborn" },
  clock: { now: Date.now, setTimeout: (fn, ms) => ({ id: 0, t: setTimeout(fn, ms).unref() }), clearTimeout: () => {}, sleep: () => Promise.resolve() },
  logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
if (${JSON.stringify(options.onSigterm)} === "kill-all") process.on("SIGTERM", () => { killAllWorkerGroups(); process.exit(143); });
let sleeper;
handle.onRecord((record) => {
  if (record.type === "pi_event" && record.event.type === "grandchild") sleeper = record.event.pid;
  if (record.type !== "ready") return;
  console.log(JSON.stringify({ worker: handle.pid, sleeper }));
  if (${JSON.stringify(options.onSigterm)} === "exit-at-ready") process.exit(0);
  setInterval(() => {}, 1000);
});
`,
    );
    const parent = spawn(
      process.execPath,
      ["--conditions=development", "--disable-warning=ExperimentalWarning", script],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    bed.track(parent.pid ?? 0);
    const line = await new Promise<string>((resolve, reject) => {
      parent.stdout.once("data", (chunk: Buffer) => resolve(String(chunk)));
      parent.once("exit", () => reject(new Error("the parent exited before it reported")));
    });
    const { worker, sleeper } = JSON.parse(line) as { worker: number; sleeper: number };
    bed.track(worker);
    bed.track(sleeper);
    const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    return { parent, worker, sleeper, exited };
  }

  it("takes the process group of every live worker with it when it exits", async () => {
    const { worker, sleeper, exited } = await startParent({ onSigterm: "exit-at-ready" });
    await exited;
    await vi.waitFor(() => {
      expect(alive(worker)).toBe(false);
      expect(alive(sleeper)).toBe(false);
    });
  });

  it("takes them with it on a signal when its handler calls killAllWorkerGroups", async () => {
    const { parent, worker, sleeper, exited } = await startParent({ onSigterm: "kill-all" });
    parent.kill("SIGTERM");
    await exited;
    await vi.waitFor(() => {
      expect(alive(worker)).toBe(false);
      expect(alive(sleeper)).toBe(false);
    });
  });

  it("leaves them behind on a signal nobody handles: the exit hook does not run for a default action", async () => {
    const { parent, worker, sleeper, exited } = await startParent({ onSigterm: "none" });
    parent.kill("SIGTERM");
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(worker)).toBe(true);
    expect(alive(sleeper)).toBe(true);
  });
});
