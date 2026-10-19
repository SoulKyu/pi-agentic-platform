import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentNetRuleset } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRIDGE_LIST,
  cleanupRigs,
  createRig,
  MISSING_RESULT,
  mac,
  nonList,
  type Rig,
} from "./testing/net-rig.ts";

/*
 * Mutants (RT-43), each run for real and killed by the named case (identity, restore and lease mutants: net-identity.test.ts):
 * - M2 allocate returns an address in use (the used-set is ignored): "allocate never hands out an address in use".
 * - M3 attach does not wait for or check the port (no poll, takes the first or any name): "a port that never appears rejects
 *   after 5 s and adds nothing" and "attach waits for the port with the clock".
 * - M4 a port name not checked by portElement (element built by hand): "a port name portElement refuses fails the start".
 * - M5 detach of a missing element throws: "detach of an element that is already gone is quiet".
 * - M7 parseLeases does not check that the MAC derives from the IP: "a damaged addresses.json stops pap-vmd...".
 */

const HELPER = "pap-helper-1a2b";
const WRITER = "pap-writer-3c4d";
const failed = (promise: Promise<unknown>): Promise<string | undefined> =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error as { code?: string }).code,
  );

let rig: Rig;
beforeEach(() => {
  rig = createRig();
});
afterEach(cleanupRigs);

describe("allocate", () => {
  it("allocate gives the lowest free address and its MAC, never .1 or .255", () => {
    const net = rig.make();
    expect(net.allocate(HELPER)).toEqual({ ip: "10.213.0.2", mac: "02:70:61:00:00:02" });
    expect(net.allocate(WRITER)).toEqual({ ip: "10.213.0.3", mac: "02:70:61:00:00:03" });
    const all = [net.allocate("pap-a-0001")];
    for (let index = 0; index < 250; index += 1) all.push(net.allocate(`pap-b-${index}`));
    const ips = all.map((address) => address.ip);
    expect(ips.at(-1)).toBe("10.213.0.254");
    expect(ips).not.toContain("10.213.0.1");
    expect(ips).not.toContain("10.213.0.255");
    expect(all.at(-1)?.mac).toBe("02:70:61:00:00:fe");
    expect(() => net.allocate("pap-c-0001")).toThrow(expect.objectContaining({ code: "unavailable" }));
  });

  it("allocate never hands out an address in use, across a pap-vmd restart", () => {
    const first = rig.make();
    const a = first.allocate(HELPER);
    const b = first.allocate(WRITER);
    const c = rig.make().allocate("pap-third-0001");
    expect(new Set([a.ip, b.ip, c.ip]).size).toBe(3);
    expect(c.ip).toBe("10.213.0.4");
  });

  it("allocate persists run/addresses.json (0600) in the state folder", () => {
    rig.make().allocate(HELPER);
    const file = path.join(rig.root, "run", "addresses.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).leases).toHaveLength(1);
  });

  it("a damaged addresses.json stops pap-vmd instead of handing out addresses blindly", () => {
    const file = path.join(rig.root, "run", "addresses.json");
    const lease = { ip: "10.213.0.5", mac: mac(5), name: HELPER, port: null, ifindex: null };
    writeFileSync(file, "{not json");
    expect(() => rig.make()).toThrow();
    writeFileSync(file, JSON.stringify({ leases: [{ ...lease, ip: "10.213.0.1", mac: mac(1) }] }));
    expect(() => rig.make()).toThrow();
    // A valid address with a MAC that is not the one its address derives.
    writeFileSync(file, JSON.stringify({ leases: [{ ...lease, mac: mac(6) }] }));
    expect(() => rig.make()).toThrow();
    writeFileSync(file, JSON.stringify({ leases: [lease] }));
    expect(() => rig.make()).not.toThrow();
  });
});

describe("attach", () => {
  it("attach runs exactly the nft and ip argv, never a shell string", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    rig.ports = ["veth1a2b"];
    await net.attach(HELPER, address);
    expect(rig.fx.calls).toEqual([
      BRIDGE_LIST,
      BRIDGE_LIST,
      [
        "/usr/sbin/nft",
        "add",
        "element",
        "bridge",
        "pap_agents",
        "ports",
        '{ "veth1a2b" . 02:70:61:00:00:02 . 10.213.0.2 }',
      ],
      [
        "/usr/sbin/ip",
        "neigh",
        "replace",
        "10.213.0.2",
        "lladdr",
        "02:70:61:00:00:02",
        "dev",
        "pap0",
        "nud",
        "permanent",
      ],
    ]);
  });

  it("attach waits for the port with the clock", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    let done = false;
    const pending = net.attach(HELPER, address).then(() => {
      done = true;
    });
    await rig.clock.advance(1000);
    expect(done).toBe(false);
    expect(nonList(rig.fx.calls)).toEqual([]);
    rig.ports = ["veth9"];
    await rig.clock.advance(300);
    await pending;
    expect(done).toBe(true);
    expect(nonList(rig.fx.calls)).toHaveLength(2);
  });

  it("a port that never appears rejects after 5 s and adds nothing", async () => {
    const net = rig.make();
    const address = net.allocate(HELPER);
    await net.prepare(HELPER);
    const outcome = failed(net.attach(HELPER, address));
    await rig.clock.advance(5100);
    expect(await outcome).toBe("failed");
    expect(nonList(rig.fx.calls)).toEqual([]);
  });

  it("a port name portElement refuses fails the start", async () => {
    for (const bad of ["veth;rm", "a-name-too-long-for-a-link", 've"th']) {
      rig = createRig();
      const net = rig.make();
      const address = net.allocate(HELPER);
      await net.prepare(HELPER);
      rig.ports = [bad];
      const outcome = failed(net.attach(HELPER, address));
      await rig.clock.advance(5100);
      expect(await outcome, bad).toBe("failed");
      expect(nonList(rig.fx.calls), bad).toEqual([]);
    }
  });

  it("attach refuses an address that allocate did not hand out, or a start that was not prepared", async () => {
    const net = rig.make();
    rig.ports = ["veth1"];
    expect(await failed(net.attach(HELPER, { ip: "10.213.0.9", mac: mac(9) }))).toBe("failed");
    const real = net.allocate(HELPER);
    expect(await failed(net.attach(HELPER, { ip: real.ip, mac: "02:00:00:00:00:99" }))).toBe("failed");
    expect(await failed(net.attach(HELPER, real))).toBe("failed");
    expect(rig.fx.calls).toEqual([]);
  });

  it("a refused nft element fails the start and detach then cleans up", async () => {
    const net = rig.make();
    rig.overrides.push((argv) => (argv[1] === "add" ? { code: 1, stderr: "boom" } : undefined));
    expect(await failed(rig.launch(net, HELPER, ["veth1"]))).toBe("failed");
    rig.overrides.length = 0;
    await net.detach(HELPER);
    expect(rig.fx.calls.at(-2)?.slice(0, 3)).toEqual(["/usr/sbin/nft", "delete", "element"]);
    expect(net.allocate(WRITER).ip).toBe("10.213.0.2");
  });
});

describe("detach", () => {
  it("detach deletes the element and the neighbour and frees the address", async () => {
    const net = rig.make();
    await rig.launch(net, HELPER, ["veth1a2b"]);
    rig.fx.calls.length = 0;
    await net.detach(HELPER);
    expect(rig.fx.calls).toEqual([
      [
        "/usr/sbin/nft",
        "delete",
        "element",
        "bridge",
        "pap_agents",
        "ports",
        '{ "veth1a2b" . 02:70:61:00:00:02 . 10.213.0.2 }',
      ],
      ["/usr/sbin/ip", "neigh", "del", "10.213.0.2", "dev", "pap0"],
    ]);
    expect(net.allocate(WRITER).ip).toBe("10.213.0.2");
  });

  it("detach of an unknown VM is quiet and runs nothing", async () => {
    await expect(rig.make().detach("pap-nobody-0000")).resolves.toBeUndefined();
    expect(rig.fx.calls).toEqual([]);
  });

  it("detach of an element that is already gone is quiet", async () => {
    const net = rig.make();
    await rig.launch(net, HELPER, ["veth1"]);
    rig.overrides.push((argv) => (argv[1] === "delete" || argv[1] === "neigh" ? MISSING_RESULT : undefined));
    await expect(net.detach(HELPER)).resolves.toBeUndefined();
    expect(net.allocate(WRITER).ip).toBe("10.213.0.2");
  });

  it("detach reports a real failure and keeps the address", async () => {
    const net = rig.make();
    await rig.launch(net, HELPER, ["veth1"]);
    rig.overrides.push((argv) =>
      argv[1] === "delete" ? { code: 1, stderr: "Operation not permitted" } : undefined,
    );
    await expect(net.detach(HELPER)).rejects.toThrow("net: detach failed");
    expect(net.allocate(WRITER).ip).toBe("10.213.0.3");
  });
});

describe("scripts/ci/netns-spoof.nft", () => {
  it("is the ruleset pap loads, byte for byte", () => {
    const file = fileURLToPath(new URL("../../../scripts/ci/netns-spoof.nft", import.meta.url));
    expect(readFileSync(file, "utf8")).toBe(agentNetRuleset());
  });
});
