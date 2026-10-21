import { DEFAULT_AGENT_RESOURCES } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { layoutOf } from "./layouts.ts";
import { type Bed, bed, IMAGE, settle, specOf, workerInput } from "./runtime-fixtures.ts";

let b: Bed;
beforeEach(async () => {
  b = bed();
  await b.runtime.stopAll();
  b.order.length = 0;
  b.backend.stop.mockClear();
});

describe("spawn", () => {
  it("starts one VM for two workers of the same agent", async () => {
    const one = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const two = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(b.starts).toHaveLength(1);
    expect(b.guestAt(0).handles).toHaveLength(2);
    expect(one.slot).toBe("slot-0");
    expect(two.slot).toBe("slot-1");
    expect(b.runtime.phase("a1")).toBe("running");
  });

  it("starts the VM once when two spawns arrive together", async () => {
    await Promise.all([
      b.runtime.spawn(specOf("a1"), workerInput(), null),
      b.runtime.spawn(specOf("a1"), workerInput(), null),
    ]);
    expect(b.starts).toHaveLength(1);
    expect(b.guestAt(0).handles).toHaveLength(2);
  });

  it("gives an isolated task its own VM keyed by its task", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.spawn(specOf("a1", { kind: "isolated", taskKey: "t1" }), workerInput(), null);
    await b.runtime.spawn(specOf("a1", { kind: "isolated", taskKey: "t1" }), workerInput(), null);
    expect(b.starts.map((s) => [s.spec.kind, s.spec.taskKey])).toEqual([
      ["thread", null],
      ["isolated", "t1"],
    ]);
    await b.runtime.stop("a1");
    expect(b.backend.stop.mock.calls).toEqual([
      ["a1", null, expect.any(String)],
      ["a1", "t1", expect.any(String)],
    ]);
  });

  it("tells the launch hook which task a VM is for (null for the thread VM)", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.spawn(specOf("a1", { kind: "isolated", taskKey: "t1" }), workerInput(), null);
    expect(b.grants.map((grant) => grant.taskKey)).toEqual([null, "t1"]);
  });

  it("hands the worker the VM's sessions folder and returns the layout, relay key and slot", async () => {
    const out = await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const guest = b.guestAt(0);
    expect(guest.spawned.at(0)?.sessionsDir).toBe("/pap/tmp/agent-vm/a1/.pi/sessions");
    expect(out.layout).toEqual(layoutOf("process", "/pap", { agentId: "a1", taskKey: null }));
    expect(out.relayKey).toBe(b.grantAt(0).relayKey);
    expect(out.relayKey).toMatch(/^[0-9a-f]{64}$/);
    expect(out.handle).toBe(guest.handles[0]);
  });

  it("tells onLaunch the address start returned, before the guest link is awaited", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    expect(b.order.slice(0, 3)).toEqual(["start", "onLaunch", "awaitGuest"]);
    expect(b.grants).toEqual([
      {
        launchId: b.launchAt(0).launchId,
        agentId: "a1",
        relayKey: b.grantAt(0).relayKey,
        address: "10.213.0.9",
        taskKey: null,
      },
    ]);
    expect(b.tokens.check("a1", b.launchAt(0).launchId, b.launchAt(0).token)).toBe(true);
  });

  it("binds the launch's image for the gateway (AVM-P8) until the VM ends", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    const { launchId } = b.launchAt(0);
    expect(b.runtime.imageOf(launchId)).toBe(IMAGE);
    expect(b.runtime.imageOf("0".repeat(32))).toBeNull();
    await b.runtime.stop("a1");
    expect(b.runtime.imageOf(launchId)).toBeNull();
  });
});

describe("capacity (R29)", () => {
  it("refuses a start over the cap and names the running agents", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.spawn(specOf("a2"), workerInput(), null);
    await expect(b.runtime.spawn(specOf("a3"), workerInput(), null)).rejects.toMatchObject({
      code: "capacity",
    });
    expect(b.capacity).toEqual([["a1", "a2"]]);
    expect(b.starts).toHaveLength(2);
  });

  it("admits a start that fits exactly and never refuses a spawn into a running VM", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.spawn(specOf("a2"), workerInput(), null);
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.spawn(
      specOf("a3", { resources: { ...DEFAULT_AGENT_RESOURCES, memoryMb: 512 } }),
      workerInput(),
      null,
    );
    expect(b.starts).toHaveLength(3);
  });

  it("counts a VM that is still starting", async () => {
    await Promise.all([
      b.runtime.spawn(specOf("a1"), workerInput(), null),
      b.runtime.spawn(specOf("a2"), workerInput(), null),
      b.runtime.spawn(specOf("a3"), workerInput(), null).catch((error: unknown) => error),
    ]);
    expect(b.starts.map((s) => s.spec.agentId)).toEqual(["a1", "a2"]);
  });

  it("frees the room when a VM stops", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.spawn(specOf("a2"), workerInput(), null);
    await b.runtime.stop("a1");
    await b.runtime.spawn(specOf("a3"), workerInput(), null);
    expect(b.starts).toHaveLength(3);
  });
});

describe("boot (RT-42)", () => {
  it("makes a spawn wait for stopAll, which stops every listed VM including ones this daemon never started", async () => {
    const fresh = bed();
    let release: (value: Array<{ agentId: string; taskKey: string | null }>) => void = () => {};
    fresh.backend.list.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const booting = fresh.runtime.stopAll();
    const spawning = fresh.runtime.spawn(specOf("a1"), workerInput(), null);
    await settle();
    expect(fresh.backend.start).not.toHaveBeenCalled();
    release([
      { agentId: "old", taskKey: null },
      { agentId: "old2", taskKey: "t9" },
    ]);
    await booting;
    await spawning;
    expect(fresh.order.slice(0, 3)).toEqual(["stop:old:", "stop:old2:t9", "start"]);
  });

  it("waits for a spawn issued before stopAll was even called", async () => {
    const fresh = bed();
    const spawning = fresh.runtime.spawn(specOf("a1"), workerInput(), null);
    await settle();
    expect(fresh.backend.start).not.toHaveBeenCalled();
    await fresh.runtime.stopAll();
    await spawning;
    expect(fresh.backend.start).toHaveBeenCalledTimes(1);
  });

  it("keeps spawns refused when the boot stop failed (fail closed)", async () => {
    const fresh = bed();
    fresh.backend.list.mockRejectedValueOnce(new Error("pap-vmd down"));
    const spawning = fresh.runtime.spawn(specOf("a1"), workerInput(), null);
    await expect(fresh.runtime.stopAll()).rejects.toThrow("pap-vmd down");
    await expect(spawning).rejects.toMatchObject({ code: "worker_failed" });
    await expect(fresh.runtime.spawn(specOf("a1"), workerInput(), null)).rejects.toMatchObject({
      code: "worker_failed",
    });
    expect(fresh.backend.start).not.toHaveBeenCalled();
  });

  it("stopAll also stops the VMs this runtime runs", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    b.listed.push({ agentId: "a1", taskKey: null });
    await b.runtime.stopAll();
    expect(b.backend.stop).toHaveBeenCalledWith("a1", null, expect.any(String));
    expect(b.runtime.phase("a1")).toBe("stopped");
    expect(b.ended).toEqual([b.launchAt(0).launchId]);
  });
});
