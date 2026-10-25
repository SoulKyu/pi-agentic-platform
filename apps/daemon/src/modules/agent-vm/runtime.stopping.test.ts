import { PapError } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Bed,
  bed,
  fakeGuest,
  IDLE_MS,
  settle,
  specOf,
  workerInput,
  agentBox,
} from "./runtime-fixtures.ts";

const A1 = { kind: "agent", id: "a1" } as const;

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
      await (how === "stop" ? b.runtime.stop(agentBox("a1")) : b.runtime.stopAll());
      expect(b.ended).toHaveLength(1);
      start.resolve({ address: "10.213.0.9" });
      expect(await spawning).toMatchObject({ code: "worker_failed" });
      expect(b.grants).toEqual([]);
      expect(b.ended).toHaveLength(1);
      expect(b.backend.stop.mock.calls.filter(([box]) => box.id === "a1")).toHaveLength(2);
      expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
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
    await b.runtime.stop(agentBox("a1"));
    expect(b.ended).toEqual([b.launchAt(0).launchId]);
    hello.resolve(guest.link);
    expect(await spawning).toMatchObject({ code: "worker_failed" });
    expect(guest.shutdown).toHaveBeenCalledTimes(1);
    expect(b.backend.stop.mock.calls.filter(([box]) => box.id === "a1")).toHaveLength(2);
    expect(b.ended).toHaveLength(1);
    expect(b.grants).toHaveLength(1);
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
    expect(b.tokens.check(agentBox("a1"), b.launchAt(0).launchId, b.launchAt(0).token)).toBe(false);
  });

  it("a guest wait that times out after the stop leaves nothing behind", async () => {
    const hello = deferred<never>();
    b.gateway.awaitGuest.mockImplementationOnce(() => hello.promise);
    const spawning = b.runtime.spawn(specOf("a1"), workerInput(), null).catch((error: unknown) => error);
    await settle();
    await b.runtime.stop(agentBox("a1"));
    // Rejected as the gateway's timeout would.
    void Promise.resolve().then(() => hello.reject(new PapError("timeout")));
    expect(await spawning).toMatchObject({ code: "timeout" });
    expect(b.ended).toHaveLength(1);
    expect(b.runtime.phase(agentBox("a1"))).toBe("stopped");
  });
});

describe("a late stop names its launch (AVM-E46, ledger T7 minor)", () => {
  // Mutant "stopLate by key": stopLate calls backend.stop without the launch id, so a backend that matches by key kills a fresh VM.
  it("both stops of a launch started and stopped in the middle carry its launch id", async () => {
    const start = deferred<{ address: string }>();
    b.backend.start.mockImplementationOnce(() => start.promise);
    const spawning = b.runtime.spawn(specOf("a1"), workerInput(), null).catch((error: unknown) => error);
    await settle();
    await b.runtime.stop(agentBox("a1"));
    start.resolve({ address: "10.213.0.9" });
    await spawning;
    const launchId = (b.backend.start.mock.calls[0]?.[1] as { launchId: string }).launchId;
    expect(b.backend.stop.mock.calls.filter(([box]) => box.id === "a1")).toEqual([
      [A1, null, launchId],
      [A1, null, launchId],
    ]);
  });

  it("a guest wait stopped late names its launch too, and the boot stops name none", async () => {
    const hello = deferred<ReturnType<typeof fakeGuest>["link"]>();
    b.gateway.awaitGuest.mockImplementationOnce(() => hello.promise);
    const spawning = b.runtime.spawn(specOf("a1"), workerInput(), null).catch((error: unknown) => error);
    await settle();
    await b.runtime.stop(agentBox("a1"));
    hello.resolve(fakeGuest(b.order).link);
    await spawning;
    const launchId = b.launchAt(0).launchId;
    expect(b.backend.stop.mock.calls.map((call) => call[2])).toEqual([launchId, launchId]);
    b.listed.push({ box: { kind: "agent", id: "x" }, taskKey: null });
    b.backend.stop.mockClear();
    await b.runtime.stopAll();
    expect(b.backend.stop.mock.calls).toEqual([[{ kind: "agent", id: "x" }, null]]);
  });
});

describe("no idle timer on a stopped VM (review I2)", () => {
  // Mutant "workerEnded guard dropped": the worker's exit re-arms a timer after teardown.
  it("leaves no pending timer after stop, and never stops the VM a second time", async () => {
    await b.runtime.spawn(specOf("a1"), workerInput(), null);
    await b.runtime.stop(agentBox("a1"));
    await settle();
    expect(b.clock.pending()).toBe(0);
    await b.clock.advance(IDLE_MS * 2);
    expect(b.backend.stop).toHaveBeenCalledTimes(1);
  });
});

describe("stopAll attempts every VM", () => {
  it("stops the others when one fails, then fails closed", async () => {
    b.listed.push(
      { box: { kind: "agent", id: "x" }, taskKey: null },
      { box: { kind: "agent", id: "y" }, taskKey: null },
      { box: { kind: "agent", id: "z" }, taskKey: "t" },
    );
    b.backend.stop.mockRejectedValueOnce(new Error("vmd refused"));
    await expect(b.runtime.stopAll()).rejects.toThrow("vmd refused");
    expect(b.backend.stop.mock.calls).toEqual([
      [{ kind: "agent", id: "x" }, null],
      [{ kind: "agent", id: "y" }, null],
      [{ kind: "agent", id: "z" }, "t"],
    ]);
    await expect(b.runtime.spawn(specOf("a1"), workerInput(), null)).rejects.toMatchObject({
      code: "worker_failed",
    });
  });
});

describe("launch steps when a stop comes mid-launch", () => {
  it("leaves guest running for the opener to fail with the stop's code", async () => {
    const hello = deferred<ReturnType<typeof fakeGuest>["link"]>();
    b.gateway.awaitGuest.mockImplementationOnce(() => hello.promise);
    const seen: string[] = [];
    const launch = {
      id: "l",
      wait: () => {},
      end: () => {},
      stopped: () => false,
      step: (s: string, st: string) => void seen.push(`${s}:${st}`),
    };
    const spawning = b.runtime.start({ ...specOf("a1"), launch }).catch((error: unknown) => error);
    await settle();
    await b.runtime.stop(agentBox("a1"));
    hello.resolve(fakeGuest(b.order).link);
    expect(await spawning).toMatchObject({ code: "worker_failed" });
    expect(seen.at(-1)).toBe("guest:done");
  });
});
