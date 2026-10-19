import {
  encodeSocketFrame,
  GUEST_BOOT_TIMEOUT_MS,
  HELLO_MAX_BYTES,
  HELLO_TIMEOUT_MS,
  PapError,
} from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT,
  FakeSocket,
  guestHello,
  guestOf,
  type Harness,
  harness,
  imageTagOf,
  OTHER_AGENT,
  spawnInput,
  workerHello,
  workerOf,
} from "./gateway-fixtures.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const header = (length: number): Buffer => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(length, 0);
  return head;
};

describe("the first frame", () => {
  it("accepts a guest hello for a live launch and hands the link to awaitGuest", async () => {
    const launch = h.launch();
    const waiting = h.gateway.awaitGuest(launch.launchId);
    const socket = h.connect();
    socket.feed(guestHello(launch));
    const link = await waiting;
    expect(socket.destroyed).toBe(false);
    expect(h.refusals()).toEqual([]);
    expect(link.shutdown).toBeTypeOf("function");
  });

  it("refuses anything that is not a hello, with agentId null", () => {
    for (const first of [{ type: "ping" }, { type: "hello" }, [1], "text", 5, null]) {
      const socket = h.connect();
      socket.feed(first);
      expect(socket.destroyed).toBe(true);
    }
    expect(h.refusals()).toEqual(Array(6).fill({ agentId: null, reason: "bad_hello" }));
  });

  it("refuses bytes that are not JSON, and invalid UTF-8", () => {
    const junk = Buffer.from("not json");
    const socket = h.connect();
    socket.feedRaw(Buffer.concat([header(junk.length), junk]));
    const bad = h.connect();
    bad.feedRaw(Buffer.concat([header(2), Buffer.from([0xc3, 0x28])]));
    expect([socket.destroyed, bad.destroyed]).toEqual([true, true]);
    expect(h.refusals().map((entry) => entry.reason)).toEqual(["bad_hello", "bad_hello"]);
  });

  // Mutant "frames bound before the body": the header alone of a first frame over HELLO_MAX_BYTES is refused, no body is
  // waited for (a decoder held to the 4 MiB bound keeps waiting and this case sees no refusal).
  it("refuses a first frame over 4 KiB on its header, before any body byte", () => {
    const socket = h.connect();
    socket.feedRaw(header(HELLO_MAX_BYTES + 1));
    expect(socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ agentId: null, reason: "too_large" }]);
  });

  it("raises the bound once the hello is accepted: a 5 KiB frame after it is not too large", async () => {
    const launch = h.launch();
    const { socket } = await guestOf(h, launch);
    socket.feed({ type: "x", pad: "y".repeat(5000) });
    expect(socket.destroyed).toBe(false);
  });

  it("closes a connection that says nothing within HELLO_TIMEOUT_MS", async () => {
    const socket = h.connect();
    await h.clock.advance(HELLO_TIMEOUT_MS - 1);
    expect(socket.destroyed).toBe(false);
    await h.clock.advance(1);
    expect(socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ agentId: null, reason: "timeout" }]);
  });

  // Mutant "decoder not stopped on close": the hello behind the bad frame is still delivered.
  it("delivers nothing after a refusal: a valid hello behind a bad one in the same chunk is ignored", async () => {
    const launch = h.launch();
    const socket = h.connect();
    socket.feedRaw(
      Buffer.concat([encodeSocketFrame({ type: "nope" }), encodeSocketFrame(guestHello(launch))]),
    );
    expect(h.refusals()).toEqual([{ agentId: null, reason: "bad_hello" }]);
    const rejected = expect(h.gateway.awaitGuest(launch.launchId)).rejects.toEqual(new PapError("timeout"));
    await h.clock.advance(GUEST_BOOT_TIMEOUT_MS);
    await rejected;
  });

  it("refuses a protocol other than ours", () => {
    const launch = h.launch();
    const socket = h.connect();
    socket.feed(guestHello(launch, { protocol: 2 }));
    expect(socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ agentId: null, reason: "protocol" }]);
  });
});

describe("who is speaking", () => {
  // Mutant "drop the agent-id check" in tokens.check: B's id on A's launch and token gets in.
  // Mutant "token check dropped" in the gateway: every case of this block gets in.
  it("refuses a valid token presented with another agent's id", () => {
    const launch = h.launch(AGENT);
    const socket = h.connect();
    socket.feed(guestHello(launch, { agentId: OTHER_AGENT }));
    expect(socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ agentId: OTHER_AGENT, reason: "token" }]);
  });

  it("refuses a revoked launch, a replayed token on another launch, and a wrong token", () => {
    const launch = h.launch();
    const other = h.launch();
    h.tokens.revoke(launch.launchId);
    for (const hello of [
      guestHello(launch),
      guestHello(other, { token: launch.token }),
      guestHello(other, { token: "0".repeat(64) }),
    ]) {
      const socket = h.connect();
      socket.feed(hello);
      expect(socket.destroyed).toBe(true);
    }
    expect(h.refusals().map((entry) => entry.reason)).toEqual(["token", "token", "token"]);
  });

  // Mutant "image check dropped": a hello with another image gets in.
  it("refuses an image other than the launch's, or a launch with no image", () => {
    const launch = h.launch();
    const other = h.launch();
    h.images.delete(other.launchId);
    const wrong = h.connect();
    wrong.feed(guestHello(launch, { imageTag: imageTagOf("b") }));
    const none = h.connect();
    none.feed(guestHello(other));
    expect(h.refusals().map((entry) => entry.reason)).toEqual(["image", "image"]);
  });

  it("allows two VMs of one agent to run different images", async () => {
    const thread = h.launch(AGENT, "a");
    const task = h.launch(AGENT, "b");
    await guestOf(h, thread);
    await guestOf(h, task);
    expect(h.refusals()).toEqual([]);
  });

  // Mutant "second guest allowed" (`everSeen` check dropped): the replay below is accepted.
  it("refuses a second guest for a launch, and a guest again after the first one closed", async () => {
    const launch = h.launch();
    const first = await guestOf(h, launch);
    const second = h.connect();
    second.feed(guestHello(launch));
    expect(second.destroyed).toBe(true);
    expect(first.socket.destroyed).toBe(false);
    first.socket.hangUp();
    await first.link.closed;
    const third = h.connect();
    third.feed(guestHello(launch));
    expect(third.destroyed).toBe(true);
    expect(h.refusals().map((entry) => entry.reason)).toEqual(["duplicate", "duplicate"]);
  });
});

describe("workers", () => {
  it("refuses a worker whose slot spawnWorker never asked", async () => {
    const launch = h.launch();
    await guestOf(h, launch);
    const socket = h.connect();
    socket.feed(workerHello(launch, "f".repeat(32)));
    expect(socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ agentId: AGENT, reason: "slot" }]);
  });

  it("refuses a worker of a launch that has no guest", () => {
    const launch = h.launch();
    const socket = h.connect();
    socket.feed(workerHello(launch, "f".repeat(32)));
    expect(h.refusals()).toEqual([{ agentId: AGENT, reason: "slot" }]);
  });

  // Mutant "slot reuse allowed" (state check dropped): the second hello of the slot is accepted.
  it("refuses the same slot twice, and again after it closed", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest);
    const again = h.connect();
    again.feed(workerHello(launch, worker.slot));
    expect(again.destroyed).toBe(true);
    expect(worker.socket.destroyed).toBe(false);
    worker.socket.hangUp();
    await worker.handle.exited;
    const late = h.connect();
    late.feed(workerHello(launch, worker.slot));
    expect(late.destroyed).toBe(true);
    expect(h.refusals().map((entry) => entry.reason)).toEqual(["duplicate", "duplicate"]);
  });

  it("refuses a worker with another agent's slot: the slot belongs to its launch", async () => {
    const launch = h.launch(AGENT);
    const intruder = h.launch(OTHER_AGENT);
    const guest = await guestOf(h, launch);
    await guestOf(h, intruder);
    const spawning = guest.link.spawnWorker(spawnInput(), null);
    const slot = (guest.socket.frames().at(-1) as { slot: string }).slot;
    const socket = h.connect();
    socket.feed(workerHello(intruder, slot));
    expect(socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ agentId: OTHER_AGENT, reason: "slot" }]);
    const real = h.connect();
    real.feed(workerHello(launch, slot));
    expect(await spawning).toBeDefined();
  });

  it("resolves spawnWorker only after the worker's hello, and asks the guest with the slot, file and packages", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    let settled = false;
    const spawning = guest.link
      .spawnWorker(spawnInput({ sessionFile: "s.jsonl" }), ["npm:pkg"])
      .then((handle) => {
        settled = true;
        return handle;
      });
    const spawn = guest.socket.frames().at(-1) as { type: string; slot: string };
    expect(spawn).toEqual({
      type: "spawn",
      slot: expect.stringMatching(/^[0-9a-f]{32}$/),
      sessionFile: "/agent/.pi/sessions/s.jsonl",
      packages: ["npm:pkg"],
    });
    await h.clock.advance(1000);
    expect(settled).toBe(false);
    h.connect().feed(
      workerHello(launch, spawn.slot, { session: { file: "s.jsonl", lastEntryId: null, size: 0 } }),
    );
    expect((await spawning).pid).toBeUndefined();
  });

  it("refuses a reopen whose hello names another file than the one asked", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const spawning = guest.link.spawnWorker(spawnInput({ sessionFile: "s.jsonl" }), null);
    const slot = (guest.socket.frames().at(-1) as { slot: string }).slot;
    const socket = h.connect();
    socket.feed(workerHello(launch, slot, { session: { file: "other.jsonl", lastEntryId: null, size: 0 } }));
    expect(socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ agentId: AGENT, reason: "protocol" }]);
    // AVM-E10: the refused hello burns the slot and fails the spawn at once, with the worker killed.
    await expect(spawning).rejects.toEqual(new PapError("worker_failed"));
    expect(guest.socket.frames().at(-1)).toEqual({ type: "signal", slot, signal: "SIGKILL" });
  });

  it("rejects spawnWorker when the guest reports the worker exited before its hello, or the guest goes away", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const first = guest.link.spawnWorker(spawnInput(), null);
    const slot = (guest.socket.frames().at(-1) as { slot: string }).slot;
    guest.socket.feed({ type: "exited", slot, code: 1, signal: null, tail: "boom" });
    await expect(first).rejects.toEqual(new PapError("worker_failed"));
    const second = guest.link.spawnWorker(spawnInput(), null);
    guest.socket.hangUp();
    await expect(second).rejects.toEqual(new PapError("worker_failed"));
    await expect(guest.link.spawnWorker(spawnInput(), null)).rejects.toEqual(new PapError("worker_failed"));
  });

  it("carries a worker's records to its handle and the guest's exit report to its exited", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest);
    const seen: string[] = [];
    worker.handle.onRecord((record) => void seen.push(record.type));
    worker.socket.feed({ type: "leaf", leafId: "e1", resync: false });
    expect(seen).toEqual(["leaf"]);
    expect(worker.handle.send({ type: "get_state", id: "x" })).toBe(true);
    expect(worker.socket.frames().at(-1)).toEqual({ type: "get_state", id: "x" });
    guest.socket.feed({ type: "exited", slot: worker.slot, code: null, signal: "SIGTERM", tail: "bye" });
    expect(await worker.handle.exited).toEqual({ code: null, signal: "SIGTERM", cause: "signal" });
    expect(worker.handle.outputTail()).toBe("bye");
    expect(worker.socket.destroyed).toBe(true);
  });

  it("closes the workers of a guest that went away", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest);
    guest.socket.hangUp();
    await guest.link.closed;
    expect(worker.socket.destroyed).toBe(true);
    expect((await worker.handle.exited).cause).toBe("exit_code");
  });

  it("answers a guest command to shut down", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    guest.link.shutdown();
    expect(guest.socket.frames().at(-1)).toEqual({ type: "shutdown" });
  });
});

describe("awaitGuest", () => {
  it("rejects timeout after GUEST_BOOT_TIMEOUT_MS, apart from the connection's own hello timeout", async () => {
    const launch = h.launch();
    const waiting = h.gateway.awaitGuest(launch.launchId);
    const settled = waiting.then(
      () => "resolved",
      (error: unknown) => error,
    );
    const idle = h.connect();
    await h.clock.advance(HELLO_TIMEOUT_MS);
    expect(idle.destroyed).toBe(true);
    await h.clock.advance(GUEST_BOOT_TIMEOUT_MS - HELLO_TIMEOUT_MS - 1);
    expect(h.clock.pending()).toBeGreaterThan(0);
    await h.clock.advance(1);
    expect(await settled).toEqual(new PapError("timeout"));
    expect(h.clock.pending()).toBe(0);
  });

  it("resolves a waiter that came after the hello, and clears its timer when the guest comes first", async () => {
    const launch = h.launch();
    const waiting = h.gateway.awaitGuest(launch.launchId);
    h.connect().feed(guestHello(launch));
    await waiting;
    // Only the guest's ping timer is left: the waiter's timer and the hello timer are cleared.
    expect(h.clock.pending()).toBe(1);
  });

  it("rejects the waiters when the gateway closes", async () => {
    const launch = h.launch();
    const waiting = h.gateway.awaitGuest(launch.launchId);
    const socket: FakeSocket = h.connect();
    await h.gateway.close();
    await expect(waiting).rejects.toEqual(new PapError("worker_failed"));
    expect(socket.destroyed).toBe(true);
  });
});

describe("what reaches the log", () => {
  it("holds no token, relay key, source address or record content", async () => {
    const launch = h.launch();
    h.connect("10.213.0.77").feed(guestHello(launch, { token: "0".repeat(64) }));
    h.connect("10.213.0.78").feed(guestHello(launch, { agentId: OTHER_AGENT }));
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest);
    worker.socket.feed({ type: "nonsense-secret-content-marker" });
    worker.socket.feedRaw(Buffer.from([0, 0, 0, 3, 120, 120, 120]));
    guest.socket.feed({ type: "exited", slot: "bad-secret-content-marker" });
    const text = JSON.stringify(h.lines);
    for (const secret of [
      launch.token,
      launch.relayKey,
      "10.213.0.77",
      "10.213.0.78",
      "secret-content-marker",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
