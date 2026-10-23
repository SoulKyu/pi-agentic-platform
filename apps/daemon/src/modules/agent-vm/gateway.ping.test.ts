import { GATEWAY_PING_MISSES, GATEWAY_PING_MS } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { EXIT_TAIL_GRACE_MS } from "./vm-worker.ts";
import { guestOf, type Harness, harness, workerOf } from "./gateway-fixtures.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("liveness", () => {
  it("pings every GATEWAY_PING_MS once the hello is accepted, not before", async () => {
    const launch = h.launch();
    const idle = h.connect();
    await h.clock.advance(GATEWAY_PING_MS - 1);
    expect(idle.frames()).toEqual([]);
    const { socket } = await guestOf(h, h.launch());
    await h.clock.advance(GATEWAY_PING_MS);
    expect(socket.frames()).toEqual([{ type: "ping" }]);
    socket.feed({ type: "pong" });
    await h.clock.advance(GATEWAY_PING_MS);
    expect(socket.frames()).toEqual([{ type: "ping" }, { type: "ping" }]);
    expect(launch.agentId).toBeDefined();
  });

  // Mutant "ping misses never close": the connection survives three missed pongs.
  it("closes a connection that missed GATEWAY_PING_MISSES pongs, and the worker's exited resolves", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest);
    guest.socket.feed({ type: "pong" });
    for (let n = 0; n < GATEWAY_PING_MISSES; n++) {
      await h.clock.advance(GATEWAY_PING_MS);
      guest.socket.feed({ type: "pong" });
      expect(worker.socket.destroyed).toBe(false);
    }
    expect(
      worker.socket.frames().filter((frame) => (frame as { type: string }).type === "ping"),
    ).toHaveLength(GATEWAY_PING_MISSES);
    await h.clock.advance(GATEWAY_PING_MS);
    expect(worker.socket.destroyed).toBe(true);
    await h.clock.advance(EXIT_TAIL_GRACE_MS);
    expect((await worker.handle.exited).cause).toBe("exit_code");
    expect(guest.socket.destroyed).toBe(false);
  });

  it("forgives misses when a pong arrives", async () => {
    const launch = h.launch();
    const { socket } = await guestOf(h, launch);
    for (let n = 0; n < 10; n++) {
      await h.clock.advance(GATEWAY_PING_MS);
      await h.clock.advance(GATEWAY_PING_MS);
      socket.feed({ type: "pong" });
    }
    expect(socket.destroyed).toBe(false);
  });

  it("answers the peer's ping with a pong and does not hand it to the worker's records", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const worker = await workerOf(h, launch, guest);
    const seen: string[] = [];
    worker.handle.onRecord((record) => void seen.push(record.type));
    worker.socket.feed({ type: "ping" });
    worker.socket.feed({ type: "pong" });
    expect(worker.socket.frames()).toEqual([{ type: "pong" }]);
    expect(seen).toEqual([]);
  });

  it("stops the pings when the connection closes", async () => {
    const launch = h.launch();
    const { socket } = await guestOf(h, launch);
    socket.hangUp();
    expect(h.clock.pending()).toBe(0);
  });
});
