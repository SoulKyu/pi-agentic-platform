import { PapError } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type Bed, bed, fakeGuest, IDLE_MS, settle, specOf, workerInput } from "./runtime-fixtures.ts";

let b: Bed;
beforeEach(async () => {
  b = bed();
  await b.runtime.stopAll();
  b.backend.stop.mockClear();
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("a stop in the middle of a start (review I1)", () => {
  // Mutants: "onLaunch guard dropped" (grants gets an entry after the end), "late stopLate dropped" (backend.stop once).
  for (const how of ["stop", "stopAll"] as const) {
    it(`${how} while the VM is starting: stopped again once it exists, onLaunch never runs`, async () => {
      const start = deferred<{ address: string }>();
      b.backend.start.mockImplementationOnce(() => start.promise);
      const spawning = b.runtime.spawn(specOf("a1"), workerInput(), null).catch((error: unknown) => error);
      await settle();
      await (how === "stop" ? b.runtime.stop("a1") : b.runtime.stopAll());
      expect(b.ended).toHaveLength(1);
      start.resolve({ address: "10.213.0.9" });
      expect(await spawning).toMatchObject({ code: "worker_failed" });
      expect(b.grants).toEqual([]);
      expect(b.ended).toHaveLength(1);
      expect(b.backend.stop.mock.calls.filter(([id]) => id === "a1")).toHaveLength(2);
      expect(b.runtime.phase("a1")).toBe("stopped");
      expect(b.gateway.awaitGuest).not.toHaveBeenCalled();
    });
  }

  it("stop while the guest is awaited: a late link is shut down and the VM stopped again", async () => {
    const guest = fakeGuest(b.order);
    const hello = deferred<typeof guest.link>();
    b.gateway.awaitGuest.mockImplementationOnce(() => hello.promise);
    const spawning = b.runtime.spawn(specOf("a1"), workerInput(), null).catch((error: unknown) => error);
    await settle();
    expect(b.grants).toHaveLength(1);
    await b.runtime.stop("a1");
    expect(b.ended).toEqual([b.launchAt(0).launchId]);
    hello.resolve(guest.link);
    expect(await spawning).toMatchObject({ code: "worker_failed" });
    expect(guest.shutdown).toHaveBeenCalledTimes(1);
    expect(b.backend.stop.mock.calls.filter(([id]) => id === "a1")).toHaveLength(2);
    expect(b.ended).toHaveLength(1);
    expect(b.grants).toHaveLength(1);
    expect(b.runtime.phase("a1")).toBe("stopped");
    expect(b.tokens.check("a1", b.launchAt(0).launchId, b.launchAt(0).token)).toBe(false);
  });

  it("a guest wait that times out after the stop leaves nothing behind", async () => {
    const hello = deferred<never>();
    b.gateway.awaitGuest.mockImplementationOnce(() => hello.promise);
    const spawning = b.runtime.spawn(specOf("a1"), workerInput(), null).catch((error: unknown) => error);
    await settle();
    await b.runtime.stop("a1");
    // Rejected as the gateway's timeout would.
    void Promise.resolve().then(() => hello.reject(new PapError("timeout")));
    expect(await spawning).toMatchObject({ code: "timeout" });
    expect(b.ended).toHaveLength(1);
    expect(b.runtime.phase("a1")).toBe("stopped");
  });
});

describe("no idle timer on a stopped VM (review I2)", () => {
  // Mutant "workerEnded guard dropped": the worker's exit re-arms a timer after teardown.
  it("leaves no pending timer after stop, and never stops the VM a second time", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.stop("a1");
    await settle();
    expect(b.clock.pending()).toBe(0);
    await b.clock.advance(IDLE_MS * 2);
    expect(b.backend.stop).toHaveBeenCalledTimes(1);
  });
});

describe("stopAll attempts every VM", () => {
  it("stops the others when one fails, then fails closed", async () => {
    b.listed.push(
      { agentId: "x", taskKey: null },
      { agentId: "y", taskKey: null },
      { agentId: "z", taskKey: "t" },
    );
    b.backend.stop.mockRejectedValueOnce(new Error("vmd refused"));
    await expect(b.runtime.stopAll()).rejects.toThrow("vmd refused");
    expect(b.backend.stop.mock.calls).toEqual([
      ["x", null],
      ["y", null],
      ["z", "t"],
    ]);
    await expect(b.runtime.spawn(specOf("a1"), workerInput(), null)).rejects.toMatchObject({
      code: "worker_failed",
    });
  });
});
