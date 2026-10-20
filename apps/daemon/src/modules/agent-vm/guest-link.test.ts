import { PapError } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT,
  guestOf,
  type Harness,
  harness,
  mirrorStub,
  spawnInput,
  workerHello,
  workerOf,
} from "./gateway-fixtures.ts";
import type { MirrorPort, WorkerSpawnInput } from "./vm-worker.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});

/** Asks the guest for a worker and says hello as it, with `session` and the answer of `mirrorFor` chosen by the test. */
async function spawnAndHello(options: {
  input: Partial<WorkerSpawnInput>;
  session?: Record<string, unknown>;
}) {
  const launch = h.launch();
  const guest = await guestOf(h, launch);
  const spawning = guest.link.spawnWorker(spawnInput(options.input), null);
  const settled = spawning.then(
    () => "spawned",
    (error: unknown) => error,
  );
  const slot = (guest.socket.frames().at(-1) as { slot: string }).slot;
  const socket = h.connect();
  socket.feed(workerHello(launch, slot, options.session ? { session: options.session } : {}));
  return { launch, guest, slot, socket, settled };
}
const signalsOf = (guest: { socket: { frames(): unknown[] } }, slot: string) =>
  guest.socket
    .frames()
    .filter(
      (frame) =>
        (frame as { type: string; slot?: string }).type === "signal" &&
        (frame as { slot: string }).slot === slot,
    );

describe("a worker hello refused in acceptWorker burns the slot (AVM-E10, T6 minor 1)", () => {
  // AVM-E40 M1. Mutant: `lost` is never called -> the first case fails; called for a new session's hello too -> the second fails.
  it("tells the owner the VM lost the file when a reopened worker does not have the recorded one", async () => {
    let told = 0;
    const run = await spawnAndHello({
      input: { sessionFile: "s.jsonl", lost: () => void told++ },
      session: { file: null, lastEntryId: null, size: 0 },
    });
    expect(await run.settled).toEqual(new PapError("worker_failed"));
    expect(told).toBe(1);
  });

  it("does not say so for a worker of a new session, nor for the file asked", async () => {
    let told = 0;
    const fresh = await spawnAndHello({
      input: { sessionFile: null, lost: () => void told++ },
      session: { file: "x.jsonl", lastEntryId: null, size: 0 },
    });
    expect(await fresh.settled).toEqual(new PapError("worker_failed"));
    expect(told).toBe(0);
  });

  it("a file that is not the one asked: SIGKILL, spawn fails worker_failed, and a correct hello after gets duplicate", async () => {
    const run = await spawnAndHello({
      input: { sessionFile: "s.jsonl" },
      session: { file: "other.jsonl", lastEntryId: null, size: 0 },
    });
    expect(run.socket.destroyed).toBe(true);
    expect(await run.settled).toEqual(new PapError("worker_failed"));
    expect(signalsOf(run.guest, run.slot)).toEqual([{ type: "signal", slot: run.slot, signal: "SIGKILL" }]);
    const again = h.connect();
    again.feed(
      workerHello(run.launch, run.slot, { session: { file: "s.jsonl", lastEntryId: null, size: 0 } }),
    );
    expect(again.destroyed).toBe(true);
    expect(h.refusals()).toEqual([
      { agentId: AGENT, reason: "protocol" },
      { agentId: AGENT, reason: "duplicate" },
    ]);
  });

  it("a mirror that refuses to open: the same", async () => {
    const run = await spawnAndHello({
      input: { sessionFile: "s.jsonl", mirrorFor: () => "refused" },
      session: { file: "s.jsonl", lastEntryId: null, size: 0 },
    });
    expect(await run.settled).toEqual(new PapError("worker_failed"));
    expect(signalsOf(run.guest, run.slot)).toHaveLength(1);
    const again = h.connect();
    again.feed(
      workerHello(run.launch, run.slot, { session: { file: "s.jsonl", lastEntryId: null, size: 0 } }),
    );
    expect(h.refusals().map((refusal) => refusal.reason)).toEqual(["protocol", "duplicate"]);
    expect(h.clock.pending()).toBe(1);
  });

  it("an unknown slot is refused as slot and burns nothing", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const spawning = guest.link.spawnWorker(spawnInput(), null);
    h.connect().feed(workerHello(launch, "f".repeat(32)));
    expect(h.refusals()).toEqual([{ agentId: AGENT, reason: "slot" }]);
    const slot = (guest.socket.frames().at(-1) as { slot: string }).slot;
    h.connect().feed(workerHello(launch, slot));
    expect((await spawning).pid).toBeUndefined();
  });
});

describe("a new session's hello must not name a file (AVM-E10, T6 minor 9a)", () => {
  it("refuses it as protocol, kills the worker and fails the spawn", async () => {
    const run = await spawnAndHello({
      input: { sessionFile: null },
      session: { file: "s.jsonl", lastEntryId: null, size: 10 },
    });
    expect(run.socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ agentId: AGENT, reason: "protocol" }]);
    expect(await run.settled).toEqual(new PapError("worker_failed"));
    expect(signalsOf(run.guest, run.slot)).toHaveLength(1);
  });

  it("accepts a new session that names no file", async () => {
    const run = await spawnAndHello({ input: { sessionFile: null } });
    expect(await run.settled).toBe("spawned");
    expect(h.refusals()).toEqual([]);
  });
});

describe("the slot is used only once the worker exists (AVM-E10, T6 minor 2)", () => {
  it("a mirror whose facts throw fails the spawn at once, kills the worker, leaves no boot timer and burns the slot", async () => {
    const broken: MirrorPort = {
      ...mirrorStub(),
      facts: () => {
        throw new Error("stat failed");
      },
    };
    const run = await spawnAndHello({
      input: { sessionFile: "s.jsonl", mirrorFor: () => broken },
      session: { file: "s.jsonl", lastEntryId: null, size: 0 },
    });
    expect(await run.settled).toEqual(new PapError("worker_failed"));
    expect(signalsOf(run.guest, run.slot)).toHaveLength(1);
    // Only the guest's ping timer is left: the boot timer was cleared by the give-up.
    expect(h.clock.pending()).toBe(1);
    const again = h.connect();
    again.feed(
      workerHello(run.launch, run.slot, { session: { file: "s.jsonl", lastEntryId: null, size: 0 } }),
    );
    expect(h.refusals().at(-1)).toEqual({ agentId: AGENT, reason: "duplicate" });
  });
});

describe("after a worker exits only the used marker stays (AVM-E10, T6 minor 5)", () => {
  it("a hello for the slot after the exit is a duplicate, and a later exit report changes nothing", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest);
    guest.socket.feed({ type: "exited", slot: worker.slot, code: 0, signal: null, tail: "" });
    expect((await worker.handle.exited).cause).toBe("clean");
    const again = h.connect();
    again.feed(workerHello(launch, worker.slot));
    expect(again.destroyed).toBe(true);
    expect(h.refusals().at(-1)).toEqual({ agentId: AGENT, reason: "duplicate" });
    guest.socket.feed({ type: "exited", slot: worker.slot, code: 1, signal: null, tail: "late" });
    expect(worker.handle.outputTail()).toBe("");
  });

  it("the guest's close still closes the workers that are alive and ignores the ones that left", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const gone = await workerOf(h, launch, guest);
    guest.socket.feed({ type: "exited", slot: gone.slot, code: 0, signal: null, tail: "" });
    const alive = await workerOf(h, launch, guest);
    guest.socket.hangUp();
    await guest.link.closed;
    expect(alive.socket.destroyed).toBe(true);
  });
});
