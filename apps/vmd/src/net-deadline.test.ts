import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeExec } from "./testing/fake-exec.ts";
import { readNetFacts } from "./net-facts.ts";
import { cleanupRigs, createRig, type Rig } from "./testing/net-rig.ts";

const order: string[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      order.push("fsync");
      return actual.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      order.push("rename");
      return actual.renameSync(from, to);
    },
  };
});

// Mutants (RT-43), each run for real:
// - one `ip`/`nft` call without a deadline (the 120 s exec default): "gives every ip and nft call a deadline".
// - `addresses.json` renamed before (or without) the fsync of its temp file: "syncs the lease file before the rename".
let rig: Rig;
beforeEach(() => {
  order.length = 0;
  rig = createRig();
});
afterEach(cleanupRigs);

describe("pap-vmd's network programs", () => {
  it("gives every ip and nft call a deadline of a few seconds", async () => {
    const net = rig.make();
    const address = await rig.launch(net, "pap-helper-1a2b", ["veth1a2b"]);
    await net.detach("pap-helper-1a2b");
    await rig.launch(net, "pap-writer-3c4d", ["veth3c4d"]);
    await rig.make().restore();
    expect(address.ip).toBe("10.213.0.2");
    const networkCalls = rig.fx.calls
      .map((argv, index) => ({ argv, timeout: rig.fx.timeouts[index] }))
      .filter(({ argv }) => argv[0] === "/usr/sbin/ip" || argv[0] === "/usr/sbin/nft");
    expect(networkCalls.length).toBeGreaterThan(5);
    for (const { argv, timeout } of networkCalls) {
      expect({
        argv: argv.join(" "),
        ok: typeof timeout === "number" && timeout > 0 && timeout <= 10_000,
      }).toEqual({
        argv: argv.join(" "),
        ok: true,
      });
    }
  });

  it("gives the readiness probe's ip and nft calls a deadline too", async () => {
    const fx = createFakeExec();
    await readNetFacts(fx.exec);
    expect(fx.calls).toHaveLength(2);
    expect(fx.timeouts).toEqual([5000, 5000]);
  });

  it("syncs the lease file before the rename", () => {
    rig.make().allocate("pap-helper-1a2b");
    expect(order).toEqual(["fsync", "rename"]);
  });
});
