import { GATEWAY_LIMITS, PapError, SESSION_CHUNK_BYTES } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type FakeSocket,
  guestHello,
  guestOf,
  type Harness,
  harness,
  mirrorStub,
  spawnInput,
  workerOf,
} from "./gateway-fixtures.ts";
import type { MirrorPort } from "./vm-worker.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const append = (offset: number, size = 4) => ({
  type: "session_append",
  file: "s.jsonl",
  offset,
  data: Buffer.alloc(size).toString("base64"),
  replace: false,
});

/** A mirror whose append at offset 100 is answered later (a long line in the parse thread). */
function slowMirror() {
  const answers: Array<(outcome: "ok") => void> = [];
  const port: MirrorPort = {
    ...mirrorStub("/m/s.jsonl"),
    onSessionAppend: (record) =>
      record.offset === 100 ? new Promise<"ok">((resolve) => answers.push(resolve)) : "ok",
  };
  return { port, answers };
}

async function connected(port: MirrorPort) {
  const launch = h.launch();
  const guest = await guestOf(h, launch);
  const worker = await workerOf(h, launch, guest, { input: spawnInput({ mirrorFor: () => port }) });
  return { worker, socket: worker.socket };
}

describe("the worker's connection reads nothing while a long line is parsed (R32)", () => {
  it("pauses the socket at the long line and resumes it when the parse answers", async () => {
    const { port, answers } = slowMirror();
    const { socket } = await connected(port);
    socket.feed(append(0));
    expect([socket.pauses, socket.resumes]).toEqual([0, 0]);
    socket.feed(append(100));
    expect([socket.pauses, socket.resumes]).toEqual([1, 0]);
    answers[0]?.("ok");
    await settle();
    expect([socket.pauses, socket.resumes]).toEqual([1, 1]);
  });

  it("does not resume while the byte meter still holds the socket, and resumes when the window turns", async () => {
    const { port, answers } = slowMirror();
    const { socket } = await connected(port);
    socket.feed(append(100));
    // Past the window's bytes the meter pauses the socket as well (the held frames are still counted).
    const frame = append(0, SESSION_CHUNK_BYTES);
    const frames = Math.ceil(GATEWAY_LIMITS.windowBytes / SESSION_CHUNK_BYTES) + 2;
    for (let i = 0; i < frames; i++) socket.feed(frame);
    const pausedByMeter = socket.pauses;
    expect(pausedByMeter).toBeGreaterThanOrEqual(2);
    answers[0]?.("ok");
    await settle();
    expect(socket.resumes).toBe(0);
    await h.clock.advance(GATEWAY_LIMITS.windowMs);
    expect(socket.resumes).toBe(1);
  });

  it("keeps the meter's resume held back by the mirror too", async () => {
    const { port, answers } = slowMirror();
    const { socket } = await connected(port);
    const frame = append(0, SESSION_CHUNK_BYTES);
    const frames = Math.ceil(GATEWAY_LIMITS.windowBytes / SESSION_CHUNK_BYTES) + 2;
    for (let i = 0; i < frames; i++) socket.feed(frame);
    socket.feed(append(100));
    await h.clock.advance(GATEWAY_LIMITS.windowMs);
    expect(socket.resumes).toBe(0);
    answers[0]?.("ok");
    await settle();
    expect(socket.resumes).toBe(1);
  });
});

describe("awaitGuest fails fast (AVM-E10, T6 minor 9b)", () => {
  it("after its guest left", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    guest.socket.hangUp();
    await expect(h.gateway.awaitGuest(launch.launchId)).rejects.toEqual(new PapError("worker_failed"));
    expect(h.clock.pending()).toBe(0);
  });

  it("after close()", async () => {
    const launch = h.launch();
    await h.gateway.close();
    await expect(h.gateway.awaitGuest(launch.launchId)).rejects.toEqual(new PapError("worker_failed"));
    expect(h.clock.pending()).toBe(0);
  });

  it("still waits for a guest that has not come yet", async () => {
    const launch = h.launch();
    const waiting = h.gateway.awaitGuest(launch.launchId);
    const socket: FakeSocket = h.connect();
    socket.feed(guestHello(launch));
    expect((await waiting).shutdown).toBeTypeOf("function");
  });
});
