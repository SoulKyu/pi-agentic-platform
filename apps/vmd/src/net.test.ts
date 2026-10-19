import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentNetRuleset } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNet, createRestoredNet } from "./net.ts";
import type { ExecResult, NetPort } from "./ops.ts";
import { createState } from "./state.ts";
import { createFakeClock, type FakeClock } from "./testing/fake-clock.ts";
import { createFakeExec, type ExecHandler, type FakeExec } from "./testing/fake-exec.ts";

/*
 * Mutants (RT-43), each run for real and killed by the named case:
 * - M1 restore skipped at start (`createRestoredNet` does not call `restore`): "createRestoredNet re-adds the guards before it returns".
 * - M2 allocate returns an address in use (the used-set is ignored): "allocate never hands out an address in use".
 * - M3 attach does not wait for or check the port (no poll, takes the first or any name): "a port that never appears rejects
 *   after 5 s and adds nothing" and "attach waits for the port with the clock".
 * - M4 a port name not checked by portElement (element built by hand): "a port name portElement refuses fails the start".
 * - M5 detach of a missing element throws: "detach of an element that is already gone is quiet".
 * - M6 an unknown `nerdctl ps` status counts as stopped (the fail-closed rule of `vm.list` inverted), so restore drops that guard: "restore keeps a VM whose status is unknown".
 */

const BRIDGE_LIST = ["/usr/sbin/ip", "-o", "link", "show", "master", "pap0"];
const PS = "/opt/pap-vm/bin/nerdctl";
const linkLine = (index: number, name: string): string =>
  `${index}: ${name}@if4: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master pap0 state UP mode DEFAULT`;
const MISSING_RESULT: Partial<ExecResult> = { code: 1, stderr: "Error: No such file or directory" };

interface Rig {
  root: string;
  clock: FakeClock;
  logs: string[];
  fx: FakeExec;
  /** The ports `ip link show master pap0` reports (mutable). */
  ports: string[];
  /** The `nerdctl ps` text. */
  ps: string;
  overrides: ExecHandler[];
  make(): NetPort;
}

let rig: Rig;

function createRig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), "net-"));
  const clock = createFakeClock();
  const logs: string[] = [];
  const log = {
    info: (event: string, fields: Record<string, unknown>) => logs.push(`${event} ${JSON.stringify(fields)}`),
  };
  const state = createState({ root, clock, log });
  state.ensure();
  const self: Rig = {
    root,
    clock,
    logs,
    ports: [],
    ps: "",
    overrides: [],
    fx: createFakeExec(async (argv) => {
      for (const override of self.overrides) {
        const answer = await override(argv);
        if (answer !== undefined) return answer;
      }
      if (argv.join(" ") === BRIDGE_LIST.join(" ")) {
        return { stdout: self.ports.map((name, index) => linkLine(10 + index, name)).join("\n") };
      }
      if (argv[0] === PS) return { stdout: self.ps };
      return undefined;
    }),
    make: () => createNet({ exec: self.fx.exec, state, clock, log }),
  };
  return self;
}

beforeEach(() => {
  rig = createRig();
});
afterEach(() => {
  rmSync(rig.root, { recursive: true, force: true });
});

const nonList = (calls: string[][]): string[][] =>
  calls.filter((call) => call.join(" ") !== BRIDGE_LIST.join(" "));
const mac = (last: number): string => `02:70:61:00:00:${last.toString(16).padStart(2, "0")}`;

describe("allocate", () => {
  it("allocate gives the lowest free address and its MAC, never .1 or .255", () => {
    const net = rig.make();
    expect(net.allocate()).toEqual({ ip: "10.213.0.2", mac: "02:70:61:00:00:02" });
    expect(net.allocate()).toEqual({ ip: "10.213.0.3", mac: "02:70:61:00:00:03" });
    const all = [net.allocate()];
    for (let index = 0; index < 250; index += 1) all.push(net.allocate());
    const ips = all.map((address) => address.ip);
    expect(ips.at(-1)).toBe("10.213.0.254");
    expect(ips).not.toContain("10.213.0.1");
    expect(ips).not.toContain("10.213.0.255");
    expect(all.at(-1)?.mac).toBe("02:70:61:00:00:fe");
    expect(() => net.allocate()).toThrow(expect.objectContaining({ code: "unavailable" }));
  });

  it("allocate never hands out an address in use, across a pap-vmd restart", () => {
    const first = rig.make();
    const a = first.allocate();
    const b = first.allocate();
    const second = rig.make();
    const c = second.allocate();
    expect(new Set([a.ip, b.ip, c.ip]).size).toBe(3);
    expect(c.ip).toBe("10.213.0.4");
  });

  it("allocate persists run/addresses.json (0600) in the state folder", () => {
    const net = rig.make();
    net.allocate();
    const file = path.join(rig.root, "run", "addresses.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).leases).toHaveLength(1);
  });

  it("an address never attached is free again after 15 minutes", async () => {
    const net = rig.make();
    expect(net.allocate().ip).toBe("10.213.0.2");
    expect(net.allocate().ip).toBe("10.213.0.3");
    await rig.clock.advance(15 * 60 * 1000 + 1);
    expect(net.allocate().ip).toBe("10.213.0.2");
  });

  it("a damaged addresses.json stops pap-vmd instead of handing out addresses blindly", () => {
    writeFileSync(path.join(rig.root, "run", "addresses.json"), "{not json");
    expect(() => rig.make()).toThrow();
    writeFileSync(
      path.join(rig.root, "run", "addresses.json"),
      JSON.stringify({ leases: [{ ip: "10.213.0.1", mac: mac(1), name: null, port: null, at: 1 }] }),
    );
    expect(() => rig.make()).toThrow();
  });
});

describe("attach", () => {
  it("attach runs exactly the nft and ip argv, never a shell string", async () => {
    const net = rig.make();
    const address = net.allocate();
    rig.ports = ["veth1a2b"];
    await net.attach("pap-helper-1a2b", address);
    expect(rig.fx.calls).toEqual([
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
    const address = net.allocate();
    let done = false;
    const pending = net.attach("pap-helper-1a2b", address).then(() => {
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
    const address = net.allocate();
    const outcome = net.attach("pap-helper-1a2b", address).then(
      () => "attached",
      (error: unknown) => (error as { code?: string }).code,
    );
    await rig.clock.advance(5100);
    expect(await outcome).toBe("failed");
    expect(nonList(rig.fx.calls)).toEqual([]);
    // The start failed: the address goes back.
    expect(net.allocate().ip).toBe("10.213.0.2");
  });

  it("attach takes the port that no VM owns yet", async () => {
    const net = rig.make();
    const a = net.allocate();
    const b = net.allocate();
    rig.ports = ["vethaaa"];
    await net.attach("pap-helper-1a2b", a);
    rig.ports = ["vethaaa", "vethbbb"];
    await net.attach("pap-writer-3c4d", b);
    expect(rig.fx.calls.at(-2)?.at(-1)).toBe('{ "vethbbb" . 02:70:61:00:00:03 . 10.213.0.3 }');
  });

  it("two new ports are ambiguous and fail the start", async () => {
    const net = rig.make();
    const address = net.allocate();
    rig.ports = ["vethaaa", "vethbbb"];
    const outcome = net
      .attach("pap-helper-1a2b", address)
      .catch((error: unknown) => (error as { code?: string }).code);
    await rig.clock.advance(5100);
    expect(await outcome).toBe("failed");
    expect(nonList(rig.fx.calls)).toEqual([]);
  });

  it("a port name portElement refuses fails the start", async () => {
    for (const bad of ["veth;rm", "a-name-too-long-for-a-link", 've"th']) {
      rig = createRig();
      const net = rig.make();
      const address = net.allocate();
      rig.ports = [bad];
      const outcome = net
        .attach("pap-helper-1a2b", address)
        .catch((error: unknown) => (error as { code?: string }).code);
      await rig.clock.advance(5100);
      expect(await outcome, bad).toBe("failed");
      expect(nonList(rig.fx.calls), bad).toEqual([]);
    }
  });

  it("attach refuses an address that allocate did not hand out", async () => {
    const net = rig.make();
    rig.ports = ["veth1"];
    await expect(net.attach("pap-helper-1a2b", { ip: "10.213.0.9", mac: mac(9) })).rejects.toThrow();
    const real = net.allocate();
    await expect(net.attach("pap-helper-1a2b", { ip: real.ip, mac: "02:00:00:00:00:99" })).rejects.toThrow();
    expect(rig.fx.calls).toEqual([]);
  });

  it("a refused nft element fails the start and detach then cleans up", async () => {
    const net = rig.make();
    const address = net.allocate();
    rig.ports = ["veth1"];
    rig.overrides.push((argv) => (argv[1] === "add" ? { code: 1, stderr: "boom" } : undefined));
    await expect(net.attach("pap-helper-1a2b", address)).rejects.toMatchObject({ code: "failed" });
    rig.overrides.length = 0;
    await net.detach("pap-helper-1a2b");
    expect(rig.fx.calls.at(-2)?.slice(0, 3)).toEqual(["/usr/sbin/nft", "delete", "element"]);
    expect(net.allocate().ip).toBe("10.213.0.2");
  });
});

describe("detach", () => {
  it("detach deletes the element and the neighbour and frees the address", async () => {
    const net = rig.make();
    const address = net.allocate();
    rig.ports = ["veth1a2b"];
    await net.attach("pap-helper-1a2b", address);
    rig.fx.calls.length = 0;
    await net.detach("pap-helper-1a2b");
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
    expect(net.allocate().ip).toBe("10.213.0.2");
  });

  it("detach of an unknown VM is quiet and runs nothing", async () => {
    await expect(rig.make().detach("pap-nobody-0000")).resolves.toBeUndefined();
    expect(rig.fx.calls).toEqual([]);
  });

  it("detach of an element that is already gone is quiet", async () => {
    const net = rig.make();
    const address = net.allocate();
    rig.ports = ["veth1"];
    await net.attach("pap-helper-1a2b", address);
    rig.overrides.push((argv) => (argv[1] === "delete" || argv[1] === "neigh" ? MISSING_RESULT : undefined));
    await expect(net.detach("pap-helper-1a2b")).resolves.toBeUndefined();
    expect(net.allocate().ip).toBe("10.213.0.2");
  });

  it("detach reports a real failure and keeps the address", async () => {
    const net = rig.make();
    const address = net.allocate();
    rig.ports = ["veth1"];
    await net.attach("pap-helper-1a2b", address);
    rig.overrides.push((argv) =>
      argv[1] === "delete" ? { code: 1, stderr: "Operation not permitted" } : undefined,
    );
    await expect(net.detach("pap-helper-1a2b")).rejects.toThrow();
    expect(net.allocate().ip).toBe("10.213.0.3");
  });
});

describe("restore", () => {
  async function twoVms(): Promise<void> {
    const net = rig.make();
    rig.ports = ["vethaaa"];
    await net.attach("pap-helper-1a2b", net.allocate());
    rig.ports = ["vethaaa", "vethbbb"];
    await net.attach("pap-writer-3c4d", net.allocate());
    rig.fx.calls.length = 0;
  }

  it("restore re-adds the element and neighbour of every VM that runs", async () => {
    await twoVms();
    rig.ps = "pap-helper-1a2b Up 3 minutes\npap-writer-3c4d Up 2 minutes\n";
    await rig.make().restore();
    const adds = nonList(rig.fx.calls).filter((call) => call[1] === "add" || call[2] === "replace");
    expect(adds.map((call) => (call.at(-1) === "permanent" ? call[3] : call.at(-1)))).toEqual([
      '{ "vethaaa" . 02:70:61:00:00:02 . 10.213.0.2 }',
      "10.213.0.2",
      '{ "vethbbb" . 02:70:61:00:00:03 . 10.213.0.3 }',
      "10.213.0.3",
    ]);
  });

  it("restore drops a stopped VM's lease and deletes what is left of it", async () => {
    await twoVms();
    rig.ps = "pap-helper-1a2b Up 3 minutes\npap-writer-3c4d Exited (0) 1 minute ago\n";
    const net = rig.make();
    await net.restore();
    expect(nonList(rig.fx.calls).filter((call) => call[1] === "add")).toHaveLength(1);
    expect(nonList(rig.fx.calls).some((call) => call[2] === "del" && call[3] === "10.213.0.3")).toBe(true);
    expect(net.allocate().ip).toBe("10.213.0.3");
  });

  it("restore keeps a VM whose status is unknown", async () => {
    await twoVms();
    rig.ps = "pap-helper-1a2b Pausing\npap-writer-3c4d \n";
    await rig.make().restore();
    expect(nonList(rig.fx.calls).filter((call) => call[1] === "add")).toHaveLength(2);
  });

  it("restore logs a running VM it has no address for and a port that is gone", async () => {
    await twoVms();
    rig.ports = ["vethaaa"];
    rig.ps = "pap-helper-1a2b Up\npap-writer-3c4d Up\npap-other-9f9f Up\n";
    await rig.make().restore();
    expect(rig.logs.some((entry) => entry.startsWith("vmd_net_unknown_vm"))).toBe(true);
    expect(rig.logs.some((entry) => entry.startsWith("vmd_net_port_missing"))).toBe(true);
  });

  it("restore rejects when the VMs cannot be listed or a guard is refused", async () => {
    await twoVms();
    rig.overrides.push((argv) => (argv.includes(PS) ? { code: 1 } : undefined));
    await expect(rig.make().restore()).rejects.toThrow();
    rig.overrides.length = 0;
    rig.ps = "pap-helper-1a2b Up\n";
    rig.overrides.push((argv) => (argv[1] === "add" ? { code: 1 } : undefined));
    await expect(rig.make().restore()).rejects.toThrow();
  });

  it("createRestoredNet re-adds the guards before it returns", async () => {
    await twoVms();
    rig.ps = "pap-helper-1a2b Up\n";
    const deps = {
      exec: rig.fx.exec,
      state: createState({ root: rig.root, clock: rig.clock, log: { info: () => undefined } }),
      clock: rig.clock,
      log: { info: () => undefined },
    };
    await createRestoredNet(deps);
    expect(nonList(rig.fx.calls).some((call) => call[1] === "add")).toBe(true);
    rig.overrides.push((argv) => (argv.includes(PS) ? { code: 1 } : undefined));
    await expect(createRestoredNet(deps)).rejects.toThrow();
  });
});

describe("scripts/ci/netns-spoof.nft", () => {
  it("is the ruleset pap loads, byte for byte", () => {
    const file = fileURLToPath(new URL("../../../scripts/ci/netns-spoof.nft", import.meta.url));
    expect(readFileSync(file, "utf8")).toBe(agentNetRuleset());
  });
});
