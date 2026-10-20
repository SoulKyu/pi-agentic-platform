import { chmodSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_NET, CNI_IPAM_DIR } from "@pap/contracts";
import { IPAM_ROOT } from "./ops.ts";
import { createFixture, seedDisk, startRequest, type Fixture } from "./testing/ops-fixture.ts";

/*
 * T20a: CNI's host-local keeps one file per reserved address, and a teardown that did not run left the file behind: the address
 * was then "not available" for CNI for good, so every start that pap-vmd gave it failed (seen on the real stack). pap-vmd's own
 * lease table decides which address a VM gets, so the file of the address it just allocated is cleared before `nerdctl run`.
 * Mutants (RT-43): the clearing after the run -> killed by "before the run"; every file cleared -> killed by "only the address".
 */
let fx: Fixture;
afterEach(() => fx.cleanup());
const reservation = (ip: string): string => path.join(fx.ipamRoot, ip);

describe("the reservation folder", () => {
  // Mutant "IPAM_ROOT typed by hand and drifted from the conflist's dataDir": host-local writes elsewhere than pap-vmd clears.
  it("is the conflist's dataDir plus the network's name (host-local's layout)", () => {
    fx = createFixture();
    expect(IPAM_ROOT).toBe(`${CNI_IPAM_DIR}/${AGENT_NET.network}`);
    expect(IPAM_ROOT).toBe("/run/pap-vm/cni-ipam/pap-agents");
  });
});

describe("vm.start and CNI's reservation of the address", () => {
  it("clears the reservation of the allocated address before the run, and says so", async () => {
    let atRun: boolean | null = null;
    fx = createFixture((argv) => {
      if (argv.includes("run")) atRun = existsSync(reservation("10.213.0.2"));
      return undefined;
    });
    seedDisk(fx);
    writeFileSync(reservation("10.213.0.2"), "stale\neth0");
    await fx.ops.handle(startRequest());
    expect(atRun).toBe(false);
    expect(existsSync(reservation("10.213.0.2"))).toBe(false);
    expect(fx.logs.filter((entry) => entry.event === "vmd_ipam_reservation_cleared")).toEqual([
      { event: "vmd_ipam_reservation_cleared", fields: { ip: "10.213.0.2" } },
    ]);
  });

  it("clears only the address it allocated, and says nothing when there is no reservation", async () => {
    fx = createFixture();
    seedDisk(fx);
    writeFileSync(reservation("10.213.0.9"), "someone else\neth0");
    await fx.ops.handle(startRequest());
    expect(existsSync(reservation("10.213.0.9"))).toBe(true);
    expect(fx.logs.some((entry) => entry.event.startsWith("vmd_ipam_reservation"))).toBe(false);
  });

  // Mutant "every lstat error is swallowed": the unreadable folder logs nothing and the next case fails.
  it("says so when the reservation cannot be looked at (not only when it is missing), and still starts", async () => {
    fx = createFixture();
    seedDisk(fx);
    chmodSync(fx.ipamRoot, 0o000);
    try {
      await fx.ops.handle(startRequest());
    } finally {
      chmodSync(fx.ipamRoot, 0o700);
    }
    expect(fx.logs.filter((entry) => entry.event === "vmd_ipam_reservation_unreadable")).toEqual([
      { event: "vmd_ipam_reservation_unreadable", fields: { ip: "10.213.0.2", code: "EACCES" } },
    ]);
  });
});
