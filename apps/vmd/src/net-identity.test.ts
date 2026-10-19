import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRestoredNet } from "./net.ts";
import { createState } from "./state.ts";
import { cleanupRigs, createRig, nonList, PS, type Rig } from "./testing/net-rig.ts";

/*
 * AVM-E37 mutants (RT-43), each run for real and killed by the named case:
 * - M1 restore skipped at start (`createRestoredNet` does not call `restore`): "createRestoredNet re-adds the guards before it returns".
 * - M6 an unknown `nerdctl ps` status counts as stopped (the fail-closed rule of `vm.list` inverted): "restore keeps a VM whose status is unknown".
 * - M8 no snapshot (attach takes any port no lease owns): "an orphan port present before the run is never chosen".
 * - M9 restore without the ifindex check (a saved name alone is enough): "restore skips a saved port whose name now has another ifindex".
 * - M10 detach ignores pending leases: "a start that fails between allocate and attach frees its address at once"
 *   and "300 failed starts in a row never exhaust the pool".
 * - M11 net-side status filter keeps only `running`: "restore keeps a Paused and a Created VM".
 */

const HELPER = "pap-helper-1a2b";
const WRITER = "pap-writer-3c4d";
const failed = (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error as { code?: string }).code,
  );
const adds = (calls: string[][]): string[] =>
  nonList(calls)
    .filter((call) => call[1] === "add")
    .map((call) => call.at(-1) ?? "");

let rig: Rig;
beforeEach(() => {
  rig = createRig();
});
afterEach(cleanupRigs);

describe("the VM's port is the one new since its run", () => {
  it("an orphan port present before the run is never chosen", async () => {
    const net = rig.make();
    rig.ports = ["vethorph"];
    await rig.launch(net, HELPER, ["vethorph", "vethnew"]);
    expect(adds(rig.fx.calls)).toEqual(['{ "vethnew" . 02:70:61:00:00:02 . 10.213.0.2 }']);
  });

  it("an orphan alone is not a new port: the start fails and nothing is added", async () => {
    const net = rig.make();
    rig.ports = ["vethorph"];
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    const outcome = failed(net.attach(HELPER, address));
    await rig.clock.advance(5100);
    expect(await outcome).toBe("failed");
    expect(adds(rig.fx.calls)).toEqual([]);
  });

  it("two new ports fail the start", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    rig.ports = ["vethaaa", "vethbbb"];
    const outcome = failed(net.attach(HELPER, address));
    await rig.clock.advance(5100);
    expect(await outcome).toBe("failed");
    expect(adds(rig.fx.calls)).toEqual([]);
  });

  it("a second VM takes its own new port, not the first VM's", async () => {
    const net = rig.make();
    await rig.launch(net, HELPER, ["vethaaa"]);
    await rig.launch(net, WRITER, ["vethaaa", "vethbbb"]);
    expect(adds(rig.fx.calls).at(-1)).toBe('{ "vethbbb" . 02:70:61:00:00:03 . 10.213.0.3 }');
  });

  it("the lease saves the port and its interface index", async () => {
    const net = rig.make();
    await rig.launch(net, HELPER, ["vethaaa"]);
    const saved = JSON.parse(
      (await import("node:fs")).readFileSync(`${rig.root}/run/addresses.json`, "utf8"),
    ) as { leases: { port: string; ifindex: number }[] };
    expect(saved.leases[0]).toMatchObject({ port: "vethaaa", ifindex: rig.ifindex.get("vethaaa") });
  });
});

describe("leases follow the VM", () => {
  it("a start that fails between allocate and attach frees its address at once", async () => {
    const net = rig.make();
    expect(net.allocate(HELPER).ip).toBe("10.213.0.2");
    await net.detach(HELPER);
    expect(rig.fx.calls).toEqual([]);
    expect(net.allocate(WRITER).ip).toBe("10.213.0.2");
  });

  it("300 failed starts in a row never exhaust the pool", async () => {
    const net = rig.make();
    for (let index = 0; index < 300; index += 1) {
      const name = `pap-helper-${index}`;
      expect(net.allocate(name).ip).toBe("10.213.0.2");
      await net.prepare(name);
      await net.detach(name);
    }
  });

  it("a failed attach keeps its reservation until detach", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    const outcome = failed(net.attach(HELPER, address));
    await rig.clock.advance(5100);
    expect(await outcome).toBe("failed");
    await net.detach(HELPER);
    expect(net.allocate(WRITER).ip).toBe("10.213.0.2");
  });
});

describe("restore", () => {
  async function twoVms(): Promise<void> {
    const net = rig.make();
    await rig.launch(net, HELPER, ["vethaaa"]);
    await rig.launch(net, WRITER, ["vethaaa", "vethbbb"]);
    rig.fx.calls.length = 0;
  }

  it("restore re-adds the element and neighbour of every VM that runs", async () => {
    await twoVms();
    rig.ps = `${HELPER} Up 3 minutes\n${WRITER} Up 2 minutes\n`;
    await rig.make().restore();
    const neighbours = nonList(rig.fx.calls).filter((call) => call[2] === "replace");
    expect(adds(rig.fx.calls)).toEqual([
      '{ "vethaaa" . 02:70:61:00:00:02 . 10.213.0.2 }',
      '{ "vethbbb" . 02:70:61:00:00:03 . 10.213.0.3 }',
    ]);
    expect(neighbours.map((call) => call[3])).toEqual(["10.213.0.2", "10.213.0.3"]);
  });

  it("restore skips a saved port whose name now has another ifindex", async () => {
    await twoVms();
    rig.ifindex.set("vethbbb", 999);
    rig.ps = `${HELPER} Up\n${WRITER} Up\n`;
    await rig.make().restore();
    expect(adds(rig.fx.calls)).toEqual(['{ "vethaaa" . 02:70:61:00:00:02 . 10.213.0.2 }']);
    expect(rig.logs.some((entry) => entry.startsWith("vmd_net_port_missing"))).toBe(true);
  });

  it("restore drops a stopped VM's lease and deletes what is left of it", async () => {
    await twoVms();
    rig.ps = `${HELPER} Up 3 minutes\n${WRITER} Exited (0) 1 minute ago\n`;
    const net = rig.make();
    await net.restore();
    expect(adds(rig.fx.calls)).toHaveLength(1);
    expect(nonList(rig.fx.calls).some((call) => call[2] === "del" && call[3] === "10.213.0.3")).toBe(true);
    expect(net.allocate("pap-third-0001").ip).toBe("10.213.0.3");
  });

  it("a lease of an absent VM is dropped at restore", async () => {
    await twoVms();
    rig.ps = `${HELPER} Up\n`;
    const net = rig.make();
    await net.restore();
    expect(net.allocate("pap-third-0001").ip).toBe("10.213.0.3");
  });

  it("restore keeps a VM whose status is unknown", async () => {
    await twoVms();
    rig.ps = `${HELPER} Pausing\n${WRITER} \n`;
    await rig.make().restore();
    expect(adds(rig.fx.calls)).toHaveLength(2);
  });

  it("restore keeps a Paused and a Created VM", async () => {
    await twoVms();
    rig.ps = `${HELPER} Up 5 minutes (Paused)\n${WRITER} Created\n`;
    await rig.make().restore();
    expect(adds(rig.fx.calls)).toHaveLength(2);
  });

  it("restore keeps the address of a running VM that was never bound, and logs the VM it has no lease for", async () => {
    const net = rig.make();
    net.allocate(HELPER);
    rig.ps = `${HELPER} Up\npap-other-9f9f Up\n`;
    await rig.make().restore();
    expect(rig.logs.some((entry) => entry.startsWith("vmd_net_unbound_vm"))).toBe(true);
    expect(rig.logs.some((entry) => entry.startsWith("vmd_net_unknown_vm"))).toBe(true);
    expect(rig.make().allocate(WRITER).ip).toBe("10.213.0.3");
  });

  it("restore rejects when the VMs cannot be listed or a guard is refused", async () => {
    await twoVms();
    rig.overrides.push((argv) => (argv[0] === PS ? { code: 1 } : undefined));
    await expect(rig.make().restore()).rejects.toThrow("net: restore cannot list the VMs");
    rig.overrides.length = 0;
    rig.ps = `${HELPER} Up\n`;
    rig.overrides.push((argv) => (argv[1] === "add" ? { code: 1 } : undefined));
    await expect(rig.make().restore()).rejects.toThrow("net: guard element refused");
  });

  it("createRestoredNet re-adds the guards before it returns", async () => {
    await twoVms();
    rig.ps = `${HELPER} Up\n`;
    const log = { info: () => undefined };
    const deps = {
      exec: rig.fx.exec,
      state: createState({ root: rig.root, clock: rig.clock, log }),
      clock: rig.clock,
      log,
    };
    await createRestoredNet(deps);
    expect(adds(rig.fx.calls)).toHaveLength(1);
    rig.overrides.push((argv) => (argv[0] === PS ? { code: 1 } : undefined));
    await expect(createRestoredNet(deps)).rejects.toThrow();
  });
});
