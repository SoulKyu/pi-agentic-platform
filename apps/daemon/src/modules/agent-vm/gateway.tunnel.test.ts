import { GATEWAY_PING_MISSES, GATEWAY_PING_MS, PapError } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { guestHello, guestOf, type Harness, harness } from "./gateway-fixtures.ts";

let h: Harness;
beforeEach(() => {
  h = harness();
});

const tunnelHello = (launch: ReturnType<Harness["launch"]>, slot: string, overrides = {}) => ({
  ...guestHello(launch),
  role: "tunnel",
  slot,
  ...overrides,
});

async function openTunnel() {
  const launch = h.launch();
  const guest = await guestOf(h, launch);
  const settled = guest.link.openTunnel({ service: "a1".repeat(16) }).then(
    (channel) => channel,
    (error: unknown) => error,
  );
  const command = guest.socket.frames().at(-1) as { type: string; slot: string; service: string };
  return { launch, guest, settled, slot: command.slot, command };
}

describe("the tunnel hello", () => {
  it("is refused as another protocol when it is not protocol 4", () => {
    const socket = h.connect();
    socket.feed(tunnelHello(h.launch(), "c".repeat(32), { protocol: 3 }));
    expect(socket.destroyed).toBe(true);
    expect(h.refusals()).toEqual([{ box: null, reason: "protocol" }]);
  });

  it("is refused on a live launch for a slot nobody asked", async () => {
    const launch = h.launch();
    const guest = await guestOf(h, launch);
    const socket = h.connect();
    socket.feed(tunnelHello(launch, "c".repeat(32)));
    expect(socket.destroyed).toBe(true);
    expect(guest.socket.destroyed).toBe(false);
    expect(h.refusals().map((line) => line.reason)).toEqual(["slot"]);
  });

  it("is refused without a guest for the launch", () => {
    const socket = h.connect();
    socket.feed(tunnelHello(h.launch(), "c".repeat(32)));
    expect(socket.destroyed).toBe(true);
    expect(h.refusals().map((line) => line.reason)).toEqual(["slot"]);
  });

  it("for an asked slot is accepted once; a second hello is refused", async () => {
    const { launch, settled, slot, command } = await openTunnel();
    expect(command).toEqual({ type: "tunnel_open", slot, service: "a1".repeat(16) });
    const socket = h.connect();
    socket.feed(tunnelHello(launch, slot));
    const channel = (await settled) as { send(frame: unknown): boolean };
    expect(channel.send({ type: "tunnel_ack", bytes: 0 })).toBe(true);
    expect(socket.frames().at(-1)).toEqual({ type: "tunnel_ack", bytes: 0 });
    expect(h.refusals()).toEqual([]);
    const again = h.connect();
    again.feed(tunnelHello(launch, slot));
    expect(again.destroyed).toBe(true);
    expect(h.refusals().map((line) => line.reason)).toEqual(["duplicate"]);
    expect(socket.destroyed).toBe(false);
  });

  it("closing the connection ends the channel", async () => {
    const { launch, settled, slot } = await openTunnel();
    const socket = h.connect();
    socket.feed(tunnelHello(launch, slot));
    const channel = (await settled) as { closed: Promise<void>; send(frame: unknown): boolean };
    socket.hangUp();
    await channel.closed;
    expect(channel.send({ type: "tunnel_end" })).toBe(false);
  });

  it("a guest report of exited for the pending slot fails the open not_found", async () => {
    const { guest, settled, slot } = await openTunnel();
    guest.socket.feed({ type: "exited", slot, code: 1, signal: null, tail: "pap-guest: no such service" });
    expect(await settled).toEqual(new PapError("not_found"));
  });

  it("the guest's connection closing ends the tunnel's connection", async () => {
    const { launch, guest, settled, slot } = await openTunnel();
    const socket = h.connect();
    socket.feed(tunnelHello(launch, slot));
    await settled;
    guest.socket.hangUp();
    expect(socket.destroyed).toBe(true);
  });

  it("a tunnel connection gets the gateway's ping like any other, and a pong keeps it", async () => {
    const { launch, guest, settled, slot } = await openTunnel();
    const socket = h.connect();
    socket.feed(tunnelHello(launch, slot));
    await settled;
    await h.clock.advance(GATEWAY_PING_MS);
    expect(socket.frames()).toEqual([{ type: "ping" }]);
    socket.feed({ type: "pong" });
    for (let n = 0; n < GATEWAY_PING_MISSES + 2; n++) {
      await h.clock.advance(GATEWAY_PING_MS);
      socket.feed({ type: "pong" });
      guest.socket.feed({ type: "pong" });
    }
    expect(socket.destroyed).toBe(false);
  });

  it("is closed after GATEWAY_PING_MISSES unanswered pings, and the guest's connection stays", async () => {
    const { launch, guest, settled, slot } = await openTunnel();
    const socket = h.connect();
    socket.feed(tunnelHello(launch, slot));
    await settled;
    for (let n = 0; n < GATEWAY_PING_MISSES; n++) {
      await h.clock.advance(GATEWAY_PING_MS);
      guest.socket.feed({ type: "pong" });
    }
    expect(socket.destroyed).toBe(false);
    await h.clock.advance(GATEWAY_PING_MS);
    expect(socket.destroyed).toBe(true);
    expect(guest.socket.destroyed).toBe(false);
  });

  it("answers the peer's ping with a pong before the tunnel sees it", async () => {
    const { launch, settled, slot } = await openTunnel();
    const socket = h.connect();
    socket.feed(tunnelHello(launch, slot));
    const channel = (await settled) as { onFrame(l: (f: unknown) => void): void };
    const got: unknown[] = [];
    channel.onFrame((frame) => void got.push(frame));
    socket.feed({ type: "ping" });
    expect(socket.frames()).toEqual([{ type: "pong" }]);
    expect(got).toEqual([]);
  });
});

describe("the service report", () => {
  it("reaches the listeners until they unsubscribe", async () => {
    const { guest } = await openTunnel();
    const got: unknown[] = [];
    const off = guest.link.onServiceReport((report) => void got.push(report));
    const report = { type: "service", id: "a1".repeat(16), state: "exited", code: 1, signal: null };
    guest.socket.feed(report);
    off();
    guest.socket.feed(report);
    expect(got).toEqual([report]);
  });
});
