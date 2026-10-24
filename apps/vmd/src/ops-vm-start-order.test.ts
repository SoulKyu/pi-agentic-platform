import { afterEach, describe, expect, it } from "vitest";
import { createLocks } from "./locks.ts";
import { createFixture, OTHER_BOX, seedDisk, startRequest, type Fixture } from "./testing/ops-fixture.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - N1 cleanup after the mutex: the `rm --force` of a failed start runs after `withStart` released the lock:
 *    killed by "the next start begins only after the failed start's container was removed".
 *  - N2a prepare after run: killed by "prepare runs inside the start lock, before nerdctl run" (order check).
 *  - N2b prepare before withStart: killed by the same case (the second start's prepare would precede the first's rm).
 */
const HELPER = "pap-helper-1a2b";
const WRITER = "pap-writer-3c4d";
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let fx: Fixture;
afterEach(() => fx.cleanup());

describe("vm.start and the start lock", () => {
  it("prepare runs inside the start lock, before nerdctl run, then attach", async () => {
    fx = createFixture(undefined, { locks: createLocks() });
    seedDisk(fx);
    await fx.ops.handle(startRequest());
    const inOrder = fx.order.filter((entry) => !entry.startsWith("rm"));
    expect(inOrder).toEqual([`prepare ${HELPER}`, "run", `attach ${HELPER}`]);
  });

  it("the next start begins only after the failed start's container was removed", async () => {
    fx = createFixture();
    let release: () => void = () => undefined;
    fx.net.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    seedDisk(fx);
    seedDisk(fx, OTHER_BOX);
    const first = fx.ops.handle(startRequest()).catch((error: unknown) => (error as { code?: string }).code);
    const second = fx.ops.handle(startRequest({ box: OTHER_BOX, launchId: "b".repeat(32) }));
    for (let index = 0; index < 5; index += 1) await flush();
    expect(fx.order).toContain(`attach ${HELPER}`);
    expect(fx.order).not.toContain(`prepare ${WRITER}`);
    release();
    expect(await first).toBe("failed");
    expect(await second).toEqual({ address: "10.213.0.3" });
    const attachFailed = fx.order.indexOf(`attach ${HELPER}`);
    const removed = fx.order.indexOf(`rm ${HELPER}`, attachFailed);
    const secondPrepare = fx.order.indexOf(`prepare ${WRITER}`);
    expect(removed).toBeGreaterThan(attachFailed);
    expect(secondPrepare).toBeGreaterThan(removed);
  });
});
