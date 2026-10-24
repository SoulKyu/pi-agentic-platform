import { afterEach, describe, expect, it, vi } from "vitest";
import { pidsWithEnv, startRuntimeBed, type RuntimeBed } from "./testing/runtime-bed.ts";

/*
 * T7 with the real guest, the real gateway and a real pi-host worker (J1). Mutants (RT-43), each run for real:
 *  - the guest ignores a closed gateway (`closed` in guest.ts no longer kills the workers) -> "closing the gateway ends the
 *    guest and its workers" fails (RT-47);
 *  - the runtime does not tear a VM down when its guest dies -> "restarts on the next spawn after a crash" fails.
 */
let bed: RuntimeBed | undefined;
afterEach(async () => {
  await bed?.dispose();
  bed = undefined;
});

const guestOf = (b: RuntimeBed, index = 0): number[] => {
  const launch = b.launches[index];
  return launch === undefined ? [] : pidsWithEnv(`PAP_LAUNCH_ID=${launch.launchId}`);
};

describe("the process backend with a real guest", () => {
  it("spawns a worker and prompts it through the scripted provider", async () => {
    bed = await startRuntimeBed({ script: { steps: [{ text: "Scripted reply." }] } });
    const { handle } = await bed.spawnReady("scout-ab12");
    const events: string[] = [];
    handle.onRecord((record) => {
      if (record.type === "pi_event") events.push(JSON.stringify(record));
    });
    const answer = await handle.request({ type: "prompt", message: "hello" });
    expect(answer.success).toBe(true);
    await vi.waitFor(() => expect(events.some((event) => event.includes("agent_end"))).toBe(true), {
      timeout: 20_000,
    });
    expect(events.some((event) => event.includes("Scripted reply."))).toBe(true);
    expect(bed.grants).toHaveLength(1);
    expect(bed.grants[0]).toMatchObject({ box: { kind: "agent", id: "scout-ab12" }, address: "127.0.0.1" });
  }, 120_000);

  it("stops the VM when its last worker has been gone for the idle time", async () => {
    bed = await startRuntimeBed({ idleMs: 300 });
    const { handle } = await bed.spawnReady("scout-ab12");
    expect(guestOf(bed)).not.toEqual([]);
    await handle.stop();
    await vi.waitFor(() => expect(bed?.stops).toEqual([{ agentId: "scout-ab12", taskKey: null }]), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(guestOf(bed as RuntimeBed)).toEqual([]), { timeout: 10_000 });
    await vi.waitFor(() => expect(bed?.ended).toEqual([bed?.launches[0]?.launchId]), { timeout: 10_000 });
    expect(bed.runtime.phase({ kind: "agent", id: "scout-ab12" })).toBe("stopped");
  }, 120_000);

  it("restarts on the next spawn after the guest crashed (M-no-teardown)", async () => {
    bed = await startRuntimeBed();
    const first = await bed.spawnReady("scout-ab12");
    const worker = pidsWithEnv(`PAP_WORKER_SLOT=${first.slot}`);
    const [guest] = guestOf(bed).filter((pid) => !worker.includes(pid));
    expect(guest).toBeGreaterThan(1);
    process.kill(guest as number, "SIGKILL");
    await first.handle.exited;
    await vi.waitFor(() => expect(bed?.runtime.phase({ kind: "agent", id: "scout-ab12" })).toBe("stopped"), {
      timeout: 20_000,
    });
    const second = await bed.spawnReady("scout-ab12");
    expect(bed.launches).toHaveLength(2);
    expect((await second.handle.request({ type: "get_state" })).success).toBe(true);
  }, 120_000);

  it("closing the daemon's gateway ends the guest and its workers (RT-47)", async () => {
    bed = await startRuntimeBed();
    const { slot } = await bed.spawnReady("scout-ab12");
    expect(pidsWithEnv(`PAP_WORKER_SLOT=${slot}`)).toHaveLength(1);
    await bed.gateway.close();
    await vi.waitFor(() => expect(pidsWithEnv(`PAP_WORKER_SLOT=${slot}`)).toEqual([]), { timeout: 20_000 });
    await vi.waitFor(() => expect(guestOf(bed as RuntimeBed)).toEqual([]), { timeout: 20_000 });
  }, 120_000);

  // T6 carry: GATEWAY_LIMITS.pendingPerSource is 4, and a VM with a thread, children and thread tasks starts five workers at once.
  it("starts five workers of one VM at once (pendingPerSource)", async () => {
    bed = await startRuntimeBed();
    const first = await bed.spawnReady("scout-ab12");
    const more = await Promise.all(Array.from({ length: 4 }, () => (bed as RuntimeBed).spawn("scout-ab12")));
    const handles = [first.handle, ...more.map((spawned) => spawned.handle)];
    expect(new Set(handles.map((handle) => (handle as unknown as { slot: string }).slot)).size).toBe(5);
    expect(bed.launches).toHaveLength(1);
  }, 120_000);

  it("starts five workers that all connect before any hello is checked", async () => {
    bed = await startRuntimeBed();
    // The VM itself first (its guest says hello), then five spawns together: five worker connections pending at once.
    await bed.spawn("scout-ab12").then((spawned) => spawned.handle.stop());
    const all = await Promise.all(Array.from({ length: 5 }, () => (bed as RuntimeBed).spawn("scout-ab12")));
    expect(all).toHaveLength(5);
  }, 120_000);
});
