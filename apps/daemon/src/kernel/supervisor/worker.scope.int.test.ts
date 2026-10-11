import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRogueBed, eventsOf, realPid, type RogueBed, waitForReady } from "../testing/rogue-bed.ts";
import type { WorkerScope } from "./scope.ts";
import { REAP_TIMEOUT_MS } from "./worker.ts";

let bed: RogueBed;
beforeEach(() => {
  bed = createRogueBed();
});
afterEach(() => bed.dispose());

// A scope whose launch prefix is plain `env`: the worker is the same process tree, and the test owns started and reap.
function fakeScope(reap: WorkerScope["reap"]) {
  const calls = { started: 0, reaped: 0 };
  const scope: WorkerScope = {
    unit: "pap-test-worker-00000000.scope",
    launch: { command: "/usr/bin/env", args: [], env: {} },
    started: async () => void calls.started++,
    reap: async (exit) => {
      calls.reaped++;
      return reap(exit);
    },
  };
  return { scope, calls };
}
const killWorker = (pid: number | undefined) => process.kill(realPid(pid), "SIGKILL");

describe("a worker launched through a scope", () => {
  it("reads the scope baseline at the first record only and reports oom when the reap says so", async () => {
    const { scope, calls } = fakeScope(async () => ({ oomKilled: true }));
    const handle = bed.rogue("echo", { scope });
    const records = bed.collect(handle);
    await waitForReady(records);
    handle.send({ type: "get_state", id: "x" });
    await vi.waitFor(() => expect(eventsOf(records, "echo")).toHaveLength(1));
    expect(calls.started).toBe(1);
    killWorker(handle.pid);
    expect(await handle.exited).toEqual({ code: null, signal: "SIGKILL", cause: "oom" });
    expect(calls.reaped).toBe(1);
  });

  it("keeps the exit's own cause when the scope says the memory limit was not it", async () => {
    const { scope } = fakeScope(async () => ({ oomKilled: false }));
    const handle = bed.rogue("echo", { scope });
    await waitForReady(bed.collect(handle));
    killWorker(handle.pid);
    expect((await handle.exited).cause).toBe("killed");
  });

  it("does not report the exit before the cgroup is reaped (R104)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { scope, calls } = fakeScope(async () => (await gate, { oomKilled: false }));
    const handle = bed.rogue("echo", { scope });
    await waitForReady(bed.collect(handle));
    let reported = false;
    void handle.exited.then(() => (reported = true));
    killWorker(handle.pid);
    await vi.waitFor(() => expect(calls.reaped).toBe(1));
    await bed.clock.advance(REAP_TIMEOUT_MS - 1);
    expect(reported).toBe(false);
    release();
    expect((await handle.exited).cause).toBe("killed");
  });

  it("reports after REAP_TIMEOUT_MS when the reap hangs, and says so", async () => {
    const { scope, calls } = fakeScope(() => new Promise(() => {}));
    const handle = bed.rogue("echo", { scope });
    await waitForReady(bed.collect(handle));
    killWorker(handle.pid);
    await vi.waitFor(() => expect(calls.reaped).toBe(1));
    await bed.clock.advance(REAP_TIMEOUT_MS);
    expect((await handle.exited).cause).toBe("killed");
    expect(bed.logged.filter((line) => line.msg === "worker_scope_reap_slow")).toHaveLength(1);
  });

  it("reports the exit's own cause when the reap fails, and logs it", async () => {
    const { scope } = fakeScope(() => Promise.reject(new Error("systemctl gone")));
    const handle = bed.rogue("echo", { scope });
    await waitForReady(bed.collect(handle));
    killWorker(handle.pid);
    expect((await handle.exited).cause).toBe("killed");
    expect(bed.logged.filter((line) => line.msg === "worker_scope_reap_failed")).toHaveLength(1);
  });
});
