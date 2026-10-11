import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../clock.ts";
import { type LogFields, type Logger, silentLogger } from "../logger.ts";
import { killAllWorkerGroups, spawnWorker, STDIO_DRAIN_MS, type WorkerHandle } from "./worker.ts";

// A child process that only does what the test makes it do, so the supervisor's decisions can be read off its
// calls: which group it signalled and when, and what it did with the pipes.
const state = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock("node:child_process", () => ({ fork: vi.fn(() => state.child) }));

class FakeChild extends EventEmitter {
  pid = 4242;
  connected = true;
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  sent: unknown[] = [];
  send = vi.fn((record: unknown, callback?: (error: Error | null) => void) => {
    this.sent.push(record);
    callback?.(null);
    return true;
  });
}

let child: FakeChild;
let clock: FakeClock;
let kill: MockInstance<typeof process.kill>;
let logs: Array<{ level: string; msg: string; fields: LogFields | undefined }>;
let handle: WorkerHandle;

const logger: () => Logger = () => ({
  ...silentLogger,
  warn: (msg, fields) => void logs.push({ level: "warn", msg, fields }),
  error: (msg, fields) => void logs.push({ level: "error", msg, fields }),
});

beforeEach(() => {
  child = new FakeChild();
  state.child = child;
  clock = createFakeClock();
  logs = [];
  kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  handle = spawnWorker({ entry: "/w.ts", execArgv: [], cwd: "/", env: {}, clock, logger: logger() });
});
afterEach(() => {
  killAllWorkerGroups();
  kill.mockRestore();
});

const signalsSent = () => kill.mock.calls.map(([pid, signal]) => `${pid}:${String(signal)}`);

describe("a worker that outlives SIGKILL", () => {
  it("is declared dead after the last wait: stop and exited both resolve, and the group is let go", async () => {
    const stopped = handle.stop();
    await clock.advance(2000);
    await clock.advance(3000);
    expect(signalsSent()).toEqual(["-4242:SIGTERM", "-4242:SIGKILL"]);
    await clock.advance(5000);
    const dead = { code: null, signal: "SIGKILL", cause: "killed" };
    expect(await stopped).toEqual(dead);
    expect(await handle.exited).toEqual(dead);
    expect(logs).toEqual([{ level: "error", msg: "worker_unkillable", fields: { pid: 4242 } }]);
    expect(killAllWorkerGroups()).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("is told to shut down with a grace shorter than the ladder's first wait", async () => {
    void handle.stop();
    expect(child.sent).toEqual([{ type: "shutdown", graceMs: 1500 }]);
    child.emit("exit", 0, null);
    child.emit("close");
    await handle.exited;
  });
});

describe("a worker that was reaped", () => {
  it("is never signalled again: its pid, which was its group id, may be someone else's", async () => {
    void handle.stop();
    await clock.advance(2000);
    expect(signalsSent()).toEqual(["-4242:SIGTERM"]);
    await clock.advance(2600);
    child.emit("exit", null, "SIGTERM");
    // The drain is still running when the ladder's last rung comes due.
    await clock.advance(STDIO_DRAIN_MS);
    expect(await handle.exited).toMatchObject({ signal: "SIGTERM", cause: "signal" });
    expect(signalsSent()).toEqual(["-4242:SIGTERM", "-4242:SIGKILL"]);
    expect(killAllWorkerGroups()).toBe(0);
  });

  it("is dropped from the groups the daemon kills on its way out as soon as it exits", () => {
    expect(killAllWorkerGroups()).toBe(1);
    child.emit("exit", 1, null);
    kill.mockClear();
    expect(killAllWorkerGroups()).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("a worker that left a pipe open", () => {
  it("is reported after the drain, with its pipes closed on our side", async () => {
    child.emit("exit", 0, null);
    await clock.advance(STDIO_DRAIN_MS - 1);
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(await handle.exited).toMatchObject({ code: 0, cause: "clean" });
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1);
  });

  it("is reported at once, with nothing destroyed, when its pipes close in time", async () => {
    child.emit("exit", 0, null);
    child.emit("close");
    expect(await handle.exited).toMatchObject({ cause: "clean" });
    expect(child.stdout.destroy).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });
});

describe("a signal that fails", () => {
  it("is logged unless the group was already gone", async () => {
    kill.mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    void handle.stop();
    await clock.advance(2000);
    expect(logs).toEqual([]);
    kill.mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    await clock.advance(3000);
    expect(logs).toEqual([
      { level: "warn", msg: "worker_signal_failed", fields: { pid: 4242, signal: "SIGKILL", code: "EPERM" } },
    ]);
    // The pretend worker is finished here, so its pid does not stay in the groups the daemon kills on its way out.
    kill.mockImplementation(() => true);
    child.emit("exit", null, "SIGKILL");
    child.emit("close");
    await handle.exited;
    expect(killAllWorkerGroups()).toBe(0);
  });
});
