import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRIDGE_LIST, cleanupRigs, createRig, nonList, type Rig } from "./testing/net-rig.ts";

/*
 * Mutants (RT-43), each run for real and killed by the named case:
 * - N3a findPort keeps polling when two ports are new: "two new ports fail at once, without waiting".
 * - N3b the exclusion of ports a lease owns is dropped: "a port a lease already owns is never taken, even when the snapshot lacks it".
 * - N3c an interrupted dump is used: "a dump that was interrupted is never used, it is retried".
 * - N4a the master filter is dropped: "a link whose master is not pap0 is ignored".
 * - N4b a name with `@` or one portElement refuses is listed: "a port name with @ or refused by portElement is logged and never added".
 */
const HELPER = "pap-helper-1a2b";
const WRITER = "pap-writer-3c4d";
const isList = (argv: readonly string[]): boolean => argv.join(" ") === BRIDGE_LIST.join(" ");
const link = (ifname: string, ifindex: number, master = "pap0"): Record<string, unknown> => ({
  ifname,
  ifindex,
  master,
});
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

describe("port listing", () => {
  it("two new ports fail at once, without waiting", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    rig.ports = ["vethaaa", "vethbbb"];
    expect(await failed(net.attach(HELPER, address))).toBe("failed");
    expect(rig.fx.calls.filter(isList)).toHaveLength(2);
    expect(adds(rig.fx.calls)).toEqual([]);
    expect(rig.logs.some((entry) => entry.startsWith('vmd_net_port_not_found {"reason":"new_ports_2"'))).toBe(
      true,
    );
  });

  it("a port a lease already owns is never taken, even when the snapshot lacks it", async () => {
    const net = rig.make();
    const address = net.allocate(WRITER);
    await net.prepare(WRITER);
    await rig.launch(net, HELPER, ["vethaaa"]);
    rig.ports = ["vethaaa"];
    const outcome = failed(net.attach(WRITER, address));
    await rig.clock.advance(5100);
    expect(await outcome).toBe("failed");
    expect(adds(rig.fx.calls)).toHaveLength(1);
  });

  it("a dump that was interrupted is never used, it is retried", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    let calls = 0;
    rig.overrides.push((argv) => {
      if (!isList(argv)) return undefined;
      calls += 1;
      if (calls > 1) return { stdout: JSON.stringify([link("vethgood", 21)]) };
      return {
        stdout: JSON.stringify([link("vethbad", 20)]),
        stderr: "Dump was interrupted and may be inconsistent.",
      };
    });
    const attached = net.attach(HELPER, address);
    await rig.clock.advance(300);
    await attached;
    expect(adds(rig.fx.calls)).toEqual(['{ "vethgood" . 02:70:61:00:00:02 . 10.213.0.2 }']);
  });

  it("prepare refuses an interrupted dump and logs it", async () => {
    const net = rig.make();
    net.allocate(HELPER);
    rig.overrides.push((argv) =>
      isList(argv) ? { stderr: "Dump was interrupted and may be inconsistent." } : undefined,
    );
    expect(await failed(net.prepare(HELPER))).toBe("failed");
    rig.overrides.length = 0;
    rig.overrides.push((argv) => (isList(argv) ? { code: 1 } : undefined));
    expect(await failed(net.prepare(HELPER))).toBe("failed");
    expect(rig.logs.filter((entry) => entry.startsWith("vmd_net_prepare_failed"))).toHaveLength(2);
  });

  it("a link whose master is not pap0 is ignored", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    rig.overrides.push((argv) =>
      isList(argv)
        ? { stdout: JSON.stringify([link("vethdock", 30, "docker0"), link("vethnew", 31)]) }
        : undefined,
    );
    await net.attach(HELPER, address);
    expect(adds(rig.fx.calls)).toEqual(['{ "vethnew" . 02:70:61:00:00:02 . 10.213.0.2 }']);
  });

  it("a port name with @ or refused by portElement is logged and never added", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    rig.overrides.push((argv) =>
      isList(argv)
        ? {
            stdout: JSON.stringify([
              link("veth1@if4", 40),
              link("veth;rm", 41),
              link("a-name-too-long-for-a-link", 42),
            ]),
          }
        : undefined,
    );
    const outcome = failed(net.attach(HELPER, address));
    await rig.clock.advance(5100);
    expect(await outcome).toBe("failed");
    expect(adds(rig.fx.calls)).toEqual([]);
    expect(
      rig.logs.filter((entry) => entry.startsWith("vmd_net_port_name_refused")).length,
    ).toBeGreaterThanOrEqual(3);
    expect(rig.logs.join("\n")).not.toContain("veth;rm");
  });
});
