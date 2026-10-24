import { AGENT_VM_MAX_FRAME_BYTES, boxKey, GATEWAY_LIMITS, encodeSocketFrame } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT_TAIL_GRACE_MS } from "./vm-worker.ts";
import { REFUSAL_QUIET_MS } from "./gateway.ts";
import { guestHello, guestOf, type Harness, harness, spawnInput, workerOf } from "./gateway-fixtures.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("connections waiting for a hello", () => {
  it("closes the 17th waiting connection (busy), and frees the place when a hello is accepted", async () => {
    const waiting = Array.from({ length: GATEWAY_LIMITS.pendingTotal }, (_, n) => h.connect(`10.213.1.${n}`));
    const extra = h.connect("10.213.2.1");
    expect(extra.destroyed).toBe(true);
    expect(waiting.every((socket) => !socket.destroyed)).toBe(true);
    expect(h.refusals()).toEqual([{ box: null, reason: "busy" }]);
    const launch = h.launch();
    waiting[0]?.feed(guestHello(launch));
    expect(waiting[0]?.destroyed).toBe(false);
    expect(h.connect("10.213.2.2").destroyed).toBe(false);
  });

  // Mutant "per-source cap dropped": the 5th connection from one address is kept.
  it("closes the 5th waiting connection from one address (busy)", () => {
    const same = Array.from({ length: GATEWAY_LIMITS.pendingPerSource }, () => h.connect("10.213.1.9"));
    const fifth = h.connect("10.213.1.9");
    expect(fifth.destroyed).toBe(true);
    expect(same.every((socket) => !socket.destroyed)).toBe(true);
    expect(h.connect("10.213.1.10").destroyed).toBe(false);
    expect(h.refusals()).toEqual([{ box: null, reason: "busy" }]);
  });

  it("frees the place of a connection that closed or was refused", () => {
    for (let n = 0; n < 3; n++) {
      for (let k = 0; k < GATEWAY_LIMITS.pendingPerSource; k++) h.connect("10.213.1.9").hangUp();
    }
    expect(h.refusals()).toEqual([]);
  });
});

describe("the byte window", () => {
  const frame = (): Buffer => {
    const body = AGENT_VM_MAX_FRAME_BYTES - 4 - 64;
    return encodeSocketFrame({ type: "pad", pad: "y".repeat(body - 20) });
  };

  it("pauses a connection past windowBytes, and resumes it when the window turns", async () => {
    const launch = h.launch();
    const { socket } = await guestOf(h, launch);
    const big = frame();
    const frames = Math.floor(GATEWAY_LIMITS.windowBytes / big.length) + 1;
    for (let n = 0; n < frames; n++) socket.feedRaw(big);
    expect(socket.pauses).toBe(1);
    expect(socket.destroyed).toBe(false);
    await h.clock.advance(GATEWAY_LIMITS.windowMs - 1);
    expect(socket.resumes).toBe(0);
    await h.clock.advance(1);
    expect(socket.resumes).toBe(1);
  });

  it("does not resume a connection that closed while paused", async () => {
    const launch = h.launch();
    const { socket } = await guestOf(h, launch);
    const big = frame();
    for (let n = 0; n < 20; n++) socket.feedRaw(big);
    expect(socket.pauses).toBe(1);
    socket.hangUp();
    await h.clock.advance(GATEWAY_LIMITS.windowMs);
    expect(socket.resumes).toBe(0);
  });
});

describe("a peer that never reads", () => {
  // Mutant "backlog not checked": the socket stays open and the handle never exits.
  it("closes the socket and ends the worker when its backlog passes writeBacklogBytes", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest, { input: spawnInput() });
    worker.socket.writableLength = GATEWAY_LIMITS.writeBacklogBytes;
    expect(worker.handle.send({ type: "get_state", id: "a" })).toBe(true);
    worker.socket.writableLength = GATEWAY_LIMITS.writeBacklogBytes + 1;
    expect(worker.handle.send({ type: "get_state", id: "b" })).toBe(false);
    expect(worker.socket.destroyed).toBe(true);
    await h.clock.advance(EXIT_TAIL_GRACE_MS);
    expect((await worker.handle.exited).cause).toBe("exit_code");
    expect(h.lines.some((line) => line.msg === "agent_gateway_backlog")).toBe(true);
  });

  it("closes the guest the same way", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    guest.socket.writableLength = GATEWAY_LIMITS.writeBacklogBytes + 1;
    guest.link.shutdown();
    expect(guest.socket.destroyed).toBe(true);
    await guest.link.closed;
  });

  it("answers false for a record over the frame bound and keeps the worker (RT-15)", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest);
    const huge = "x".repeat(AGENT_VM_MAX_FRAME_BYTES);
    expect(worker.handle.send({ type: "prompt", id: "p", message: huge })).toBe(false);
    expect(worker.socket.destroyed).toBe(false);
    expect(worker.handle.send({ type: "get_state", id: "q" })).toBe(true);
  });
});

// Mutant "log throttle removed" (every refusal logged): the 3rd bad hello logs. Mutant "one counter for all reasons": the
// first "token" refusal after 3 bad hellos is not logged.
describe("the refusal log", () => {
  it("logs the 1st, 2nd, 4th and 8th refusal of a reason with its count, and counts each reason alone", () => {
    for (let n = 0; n < 9; n++) h.connect(`10.213.3.${n}`).feed({ type: "nonsense" });
    const logged = h.lines.filter((line) => line.msg === "agent_gateway_refused");
    expect(logged.map((line) => [line.reason, line.count])).toEqual([
      ["bad_hello", 1],
      ["bad_hello", 2],
      ["bad_hello", 4],
      ["bad_hello", 8],
    ]);
    const launch = h.launch();
    h.connect("10.213.3.50").feed(guestHello(launch, { token: "0".repeat(64) }));
    expect(h.refusals().at(-1)).toEqual({ box: boxKey(launch.box), reason: "token" });
  });

  // S2 m2. Mutant: the count never resets -> after a burst, a later refusal of the reason is not logged until the next power of two.
  it("starts a reason's count again after a quiet hour, and not before", async () => {
    for (let n = 0; n < 5; n++) h.connect(`10.213.4.${n}`).feed({ type: "nonsense" });
    const counts = () =>
      h.lines.filter((line) => line.msg === "agent_gateway_refused").map((line) => line.count);
    expect(counts()).toEqual([1, 2, 4]);
    await h.clock.advance(REFUSAL_QUIET_MS - 1);
    h.connect("10.213.4.20").feed({ type: "nonsense" });
    expect(counts()).toEqual([1, 2, 4]);
    await h.clock.advance(REFUSAL_QUIET_MS);
    h.connect("10.213.4.21").feed({ type: "nonsense" });
    expect(counts()).toEqual([1, 2, 4, 1]);
  });
});
