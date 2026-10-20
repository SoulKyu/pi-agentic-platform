import { afterEach, describe, expect, it } from "vitest";
import { createLocks, type Locks } from "./locks.ts";
import { AGENT, createFixture, type Fixture } from "./testing/ops-fixture.ts";

/*
 * AVM-E62 (b): after each `vm.stop` pap-vmd sweeps the unmounted `cnitest-*` namespace files, under the start lock.
 * Mutant (RT-43), run for real: the sweep dropped from `stop` -> killed by "sweeps once after a stop".
 */
let fx: Fixture;
afterEach(() => fx.cleanup());

describe("vm.stop and the namespace sweep", () => {
  it("sweeps once after a stop, after the container is gone and while the start lock is held", async () => {
    const seen: string[] = [];
    let holding = false;
    const real = createLocks();
    const locks: Locks = {
      ...real,
      withStart: (run) => {
        holding = true;
        return real.withStart(run).finally(() => (holding = false));
      },
    };
    fx = createFixture(
      (argv) => {
        if (argv.includes("rm")) seen.push("rm");
        return undefined;
      },
      {
        locks,
        sweepNetns: () => {
          seen.push(holding ? "sweep (start lock held)" : "sweep");
          return 0;
        },
      },
    );
    await fx.ops.handle({ op: "vm.stop", agentId: AGENT, taskKey: null });
    expect(seen).toEqual(["rm", "sweep (start lock held)"]);
  });

  it("a sweep that throws does not fail the stop", async () => {
    fx = createFixture(undefined, {
      sweepNetns: () => {
        throw new Error("boom");
      },
    });
    await expect(fx.ops.handle({ op: "vm.stop", agentId: AGENT, taskKey: null })).resolves.toEqual({
      stopped: true,
    });
  });
});
