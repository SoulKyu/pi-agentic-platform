import { afterEach, describe, expect, it } from "vitest";
import type { ExecHandler } from "./testing/fake-exec.ts";
import { createFixture, OTHER_AGENT, seedDisk, startRequest, type Fixture } from "./testing/ops-fixture.ts";

/*
 * S1 mutants (RT-43), each run for real:
 *  - M-rm-failed-not-recorded (item 3): `removeContainer` does not list a name whose `rm --force` failed: killed by "a start is
 *    refused while a container whose removal failed is not stopped".
 *  - M-rm-failed-not-retried (item 3): the head of `withStart` does not retry: killed by "retries the failed removal ... before
 *    the next start's prepare".
 *  - M-listed-ignores-stopped (item 3): a listed name refuses even when inspect says exited: killed by "a listed container that is
 *    stopped is dropped".
 *  - M-unleased-not-seeded (item 3): the restore's unleased names are not listed: killed by "a running container without a lease
 *    at restore blocks starts until it is removed".
 *  - M-no-facts-check (item 4): `vm.start` does not read the ruleset and the bridge: killed by "refuses `unavailable` without its
 *    nftables table / without the pap0 bridge".
 *  - M-bridge-ignores-up (item 4): only the table is checked: killed by the bridge case.
 */
const HELPER = "pap-helper-1a2b";
const WRITER = "pap-writer-3c4d";
const isRm = (argv: readonly string[]): boolean => argv.includes("rm");
const isRun = (argv: readonly string[]): boolean => argv.includes("run");
const isInspect = (argv: readonly string[]): boolean => argv.includes("inspect");
const runs = (fx: Fixture): number => fx.exec.calls.filter(isRun).length;
const other = (): Record<string, unknown> => startRequest({ agentId: OTHER_AGENT, launchId: "b".repeat(32) });

let fx: Fixture;
afterEach(() => fx.cleanup());

describe("a container whose removal failed", () => {
  /** `rm --force pap-helper-1a2b` fails while `broken` is set; `inspect` answers `inspected`. */
  const rig = (inspected: string, unleased: string[] = []) => {
    const state = { broken: true, inspected };
    const handler: ExecHandler = (argv) => {
      if (isRun(argv) && argv.includes(HELPER)) return { code: 1 };
      if (isRm(argv) && argv.at(-1) === HELPER && state.broken)
        return { code: 1, stderr: "containerd refused" };
      if (isInspect(argv)) return { stdout: `${state.inspected}\n` };
      return undefined;
    };
    fx = createFixture(handler, { unleased });
    seedDisk(fx);
    seedDisk(fx, OTHER_AGENT);
    return state;
  };

  it("a start is refused while a container whose removal failed is not stopped", async () => {
    rig("running");
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "failed" });
    await expect(fx.ops.handle(other())).rejects.toMatchObject({ code: "unavailable" });
    expect(runs(fx)).toBe(1); // only the first start's failed run
    expect(fx.net.events.filter((event) => event === `prepare ${WRITER}`)).toEqual([]);
  });

  it("retries the failed removal at the head of the next start, before its prepare", async () => {
    const state = rig("running");
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "failed" });
    state.broken = false;
    expect(await fx.ops.handle(other())).toEqual({ address: "10.213.0.3" });
    const retried = fx.order.lastIndexOf(`rm ${HELPER}`);
    expect(retried).toBeGreaterThan(fx.order.indexOf(`attach ${HELPER}`));
    expect(retried).toBeLessThan(fx.order.indexOf(`prepare ${WRITER}`));
    // The name is no longer listed: a third start is not refused.
    state.broken = true;
    expect(await fx.ops.handle(other())).toEqual({ address: "10.213.0.4" });
  });

  it("a listed container that is stopped is dropped", async () => {
    rig("exited");
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "failed" });
    expect(await fx.ops.handle(other())).toEqual({ address: "10.213.0.3" });
  });

  it("an inspect that fails or says something unknown keeps the refusal", async () => {
    rig("dead");
    await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "failed" });
    await expect(fx.ops.handle(other())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("a running container without a lease at restore blocks starts until it is removed", async () => {
    const state = rig("running", [HELPER]);
    state.broken = true;
    await expect(fx.ops.handle(other())).rejects.toMatchObject({ code: "unavailable" });
    state.broken = false;
    expect(await fx.ops.handle(other())).toEqual({ address: "10.213.0.3" }); // the refused start had taken .2
  });
});

describe("vm.start without its network", () => {
  const nft = (argv: readonly string[]) => (argv[0] === "/usr/sbin/nft" ? { code: 1 } : undefined);
  const down = (argv: readonly string[]) =>
    argv[0] === "/usr/sbin/ip" && argv.includes("link")
      ? { stdout: "7: pap0: <NO-CARRIER,BROADCAST,MULTICAST> mtu 1500 state DOWN\n" }
      : undefined;
  const missing = (argv: readonly string[]) =>
    argv[0] === "/usr/sbin/ip" && argv.includes("link") ? { code: 1 } : undefined;

  for (const [label, handler] of [
    ["its nftables table", nft],
    ["the pap0 bridge up", down],
    ["the pap0 bridge", missing],
  ] as const)
    it(`refuses unavailable without ${label}, and starts nothing`, async () => {
      fx = createFixture(handler);
      seedDisk(fx);
      await expect(fx.ops.handle(startRequest())).rejects.toMatchObject({ code: "unavailable" });
      expect(fx.exec.calls.filter((argv) => isRun(argv) || isRm(argv))).toEqual([]);
      expect(fx.net.events).toEqual([]);
    });
});
