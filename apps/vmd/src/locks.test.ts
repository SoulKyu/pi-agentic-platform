import { describe, expect, it } from "vitest";
import { VmdFailure } from "./errors.ts";
import { createLocks, createRoomCheck } from "./locks.ts";

/*
 * Mutants (RT-43) killed here, run for real:
 *  - M-no-agent-lock: `withAgent` runs the operation at once: killed by "two operations of one agent run one after the other".
 *  - M-no-join: `joinBuild` / `joinPopulate` start a second run: killed by "two builds of one tag run once".
 *  - M-no-start-mutex: `withStart` runs at once: killed by "two starts never overlap".
 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("per-agent lock", () => {
  it("two operations of one agent run one after the other, in order", async () => {
    const locks = createLocks();
    const first = gate();
    const events: string[] = [];
    const a = locks.withAgent("helper-1a2b", async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
    });
    const b = locks.withAgent("helper-1a2b", async () => {
      events.push("b:start");
    });
    await tick();
    expect(events).toEqual(["a:start"]);
    first.open();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("two agents do not wait for each other", async () => {
    const locks = createLocks();
    const first = gate();
    const events: string[] = [];
    const a = locks.withAgent("helper-1a2b", async () => {
      await first.promise;
      events.push("a");
    });
    await locks.withAgent("writer-3c4d", async () => {
      events.push("b");
    });
    expect(events).toEqual(["b"]);
    first.open();
    await a;
  });

  it("a failed operation does not block the next, and its error reaches its own caller", async () => {
    const locks = createLocks();
    const failing = locks.withAgent("helper-1a2b", () => Promise.reject(new VmdFailure("conflict")));
    const next = locks.withAgent("helper-1a2b", async () => "ran");
    await expect(failing).rejects.toMatchObject({ code: "conflict" });
    await expect(next).resolves.toBe("ran");
  });

  it("refuses with `capacity` past 64 queued operations of one agent and recovers", async () => {
    const locks = createLocks();
    const hold = gate();
    const queued = Array.from({ length: 64 }, () => locks.withAgent("helper-1a2b", () => hold.promise));
    await expect(locks.withAgent("helper-1a2b", async () => 1)).rejects.toMatchObject({ code: "capacity" });
    hold.open();
    await Promise.all(queued);
    await expect(locks.withAgent("helper-1a2b", async () => 1)).resolves.toBe(1);
  });
});

describe("joining", () => {
  it("two builds of one tag run once and both callers get the result; a build after it runs again", async () => {
    const locks = createLocks();
    const hold = gate();
    let runs = 0;
    const run = async (): Promise<number> => {
      runs += 1;
      await hold.promise;
      return runs;
    };
    const a = locks.joinBuild("pap-agent-base-x", run);
    const b = locks.joinBuild("pap-agent-base-x", run);
    const c = locks.joinBuild("pap-agent-agent-y", run);
    hold.open();
    expect(await a).toBe(await b);
    await c;
    expect(runs).toBe(2);
    await locks.joinBuild("pap-agent-base-x", async () => ++runs);
    expect(runs).toBe(3);
  });

  it("a failed build is joined by the second caller (same rejection) and does not stick", async () => {
    const locks = createLocks();
    const hold = gate();
    let runs = 0;
    const run = async (): Promise<void> => {
      runs += 1;
      await hold.promise;
      throw new VmdFailure("failed");
    };
    const a = locks.joinBuild("t", run);
    const b = locks.joinBuild("t", run);
    hold.open();
    await expect(a).rejects.toMatchObject({ code: "failed" });
    await expect(b).rejects.toMatchObject({ code: "failed" });
    expect(runs).toBe(1);
    await expect(locks.joinBuild("t", async () => "again")).resolves.toBe("again");
  });

  it("two populates of one agent run once, under the agent's lock", async () => {
    const locks = createLocks();
    const hold = gate();
    const events: string[] = [];
    let runs = 0;
    const populate = async (): Promise<void> => {
      runs += 1;
      events.push("populate");
      await hold.promise;
    };
    const first = locks.joinPopulate("helper-1a2b", populate);
    const second = locks.joinPopulate("helper-1a2b", populate);
    const grow = locks.withAgent("helper-1a2b", async () => {
      events.push("grow");
    });
    await tick();
    expect(events).toEqual(["populate"]);
    hold.open();
    await Promise.all([first, second, grow]);
    expect(runs).toBe(1);
    expect(events).toEqual(["populate", "grow"]);
  });
});

describe("start mutex (AVM-P12)", () => {
  it("two starts never overlap, even for two agents", async () => {
    const locks = createLocks();
    const hold = gate();
    const events: string[] = [];
    const a = locks.withStart(async () => {
      events.push("a:start");
      await hold.promise;
      events.push("a:end");
    });
    const b = locks.withStart(async () => {
      events.push("b:start");
    });
    await tick();
    expect(events).toEqual(["a:start"]);
    hold.open();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });
});

describe("room check", () => {
  const check = (free: number, floor: number) =>
    createRoomCheck({ freeMb: async () => free, minFreeMb: floor });

  it("answers `disk_low` when the free space is less than the need plus the floor", async () => {
    await expect(check(1500, 1024)(476)).resolves.toBeUndefined();
    await expect(check(1500, 1024)(477)).rejects.toMatchObject({ code: "disk_low" });
    await expect(check(1023, 1024)(0)).rejects.toMatchObject({ code: "disk_low" });
  });

  it("a floor of 0 still checks the need", async () => {
    await expect(check(10, 0)(10)).resolves.toBeUndefined();
    await expect(check(10, 0)(11)).rejects.toMatchObject({ code: "disk_low" });
  });

  it("an unreadable file system fails closed", async () => {
    const broken = createRoomCheck({
      freeMb: () => Promise.reject(new Error("EIO")),
      minFreeMb: 1,
    });
    await expect(broken(1)).rejects.toMatchObject({ code: "disk_low" });
  });
});
