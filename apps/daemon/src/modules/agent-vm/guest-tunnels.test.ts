import { PapError, type Hello } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { BoxTunnelChannel } from "../../kernel/boxes.ts";
import { createLogger } from "../../kernel/logger.ts";
import {
  createGuestTunnels,
  type GuestTunnels,
  TUNNEL_OPEN_MS,
  type TunnelConnection,
} from "./guest-tunnels.ts";
import type { Wire } from "./vm-worker.ts";

const SERVICE = "a1".repeat(16);

class FakeWire implements Wire {
  readonly sent: unknown[] = [];
  closes = 0;
  alive = true;
  send(frame: unknown): boolean {
    if (!this.alive) return false;
    this.sent.push(frame);
    return true;
  }
  close(): void {
    this.closes++;
  }
  pause(): void {}
  resume(): void {}
}

let clock: FakeClock;
let guest: FakeWire;
let tunnels: GuestTunnels;
let lines: Array<Record<string, unknown>>;
beforeEach(() => {
  clock = createFakeClock();
  guest = new FakeWire();
  lines = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  tunnels = createGuestTunnels({ clock, logger, box: "agent:a", wire: guest });
});

const hello = (slot: string) => ({ role: "tunnel", slot }) as unknown as Extract<Hello, { role: "tunnel" }>;
const slotOf = (): string => (guest.sent.at(-1) as { slot: string }).slot;

function ask() {
  const settled = tunnels.open(SERVICE).then(
    (channel) => channel,
    (error: unknown) => error,
  );
  return { settled, slot: slotOf() };
}

describe("the tunnels of one guest link", () => {
  it("asks with tunnel_open and resolves once the hello of that slot is accepted", async () => {
    const { settled, slot } = ask();
    expect(guest.sent.at(-1)).toEqual({ type: "tunnel_open", slot, service: SERVICE });
    const connection = tunnels.accept(hello(slot), new FakeWire());
    expect(typeof connection).toBe("object");
    expect(((await settled) as BoxTunnelChannel).send({ type: "tunnel_end" })).toBe(true);
  });

  it("10 000 tunnels opened and closed leave 0 slot entries", async () => {
    for (let n = 0; n < 10_000; n++) {
      const { settled, slot } = ask();
      const connection = tunnels.accept(hello(slot), new FakeWire()) as TunnelConnection;
      const channel = (await settled) as BoxTunnelChannel;
      connection.closed();
      await channel.closed;
    }
    expect(tunnels.size()).toBe(0);
  });

  it("a timed-out, refused or link-lost open leaves no entry, and its late hello is refused slot", async () => {
    const timed = ask();
    await clock.advance(TUNNEL_OPEN_MS);
    expect(await timed.settled).toEqual(new PapError("timeout"));
    expect(tunnels.size()).toBe(0);
    expect(tunnels.accept(hello(timed.slot), new FakeWire())).toBe("slot");

    const refused = ask();
    expect(tunnels.refused(refused.slot)).toBe(true);
    expect(await refused.settled).toEqual(new PapError("not_found"));
    expect(tunnels.size()).toBe(0);
    expect(tunnels.accept(hello(refused.slot), new FakeWire())).toBe("slot");
    expect(tunnels.refused(refused.slot)).toBe(false);

    const lost = ask();
    tunnels.closed();
    expect(await lost.settled).toEqual(new PapError("box_stopped"));
    expect(tunnels.size()).toBe(0);
    expect(tunnels.accept(hello(lost.slot), new FakeWire())).toBe("slot");
    await expect(tunnels.open(SERVICE)).rejects.toEqual(new PapError("box_stopped"));
  });

  it("an open the wire cannot send fails box_stopped and leaves no entry", async () => {
    guest.alive = false;
    await expect(tunnels.open(SERVICE)).rejects.toEqual(new PapError("box_stopped"));
    expect(tunnels.size()).toBe(0);
  });

  it("accepts the hello of an asked slot once, refuses an unknown slot and a second hello", async () => {
    expect(tunnels.accept(hello("f".repeat(32)), new FakeWire())).toBe("slot");
    const { settled, slot } = ask();
    expect(typeof tunnels.accept(hello(slot), new FakeWire())).toBe("object");
    expect(tunnels.accept(hello(slot), new FakeWire())).toBe("duplicate");
    await settled;
    expect(tunnels.size()).toBe(1);
  });

  it("delivers the frames in order, those sent before the listener included", async () => {
    const { settled, slot } = ask();
    const connection = tunnels.accept(hello(slot), new FakeWire()) as TunnelConnection;
    connection.frame({ type: "tunnel_data", data: "aGk=" });
    connection.frame({ type: "tunnel_end" });
    const channel = (await settled) as BoxTunnelChannel;
    const got: unknown[] = [];
    channel.onFrame((frame) => void got.push(frame));
    connection.frame({ type: "tunnel_ack", bytes: 1 });
    expect(got).toEqual([
      { type: "tunnel_data", data: "aGk=" },
      { type: "tunnel_end" },
      { type: "tunnel_ack", bytes: 1 },
    ]);
  });

  it("a frame that is not a tunnel frame closes that tunnel and logs no content; the link closing ends every open tunnel", async () => {
    const first = ask();
    const firstWire = new FakeWire();
    const firstConnection = tunnels.accept(hello(first.slot), firstWire) as TunnelConnection;
    const second = ask();
    const secondWire = new FakeWire();
    tunnels.accept(hello(second.slot), secondWire);
    const channels = [(await first.settled) as BoxTunnelChannel, (await second.settled) as BoxTunnelChannel];

    firstConnection.frame({ type: "pty_output", data: "SECRET-CONTENT" });
    expect(firstWire.closes).toBe(1);
    expect(secondWire.closes).toBe(0);
    const bad = lines.filter((line) => line.msg === "agent_gateway_tunnel_bad_frame");
    expect(bad).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain("SECRET-CONTENT");

    tunnels.closed();
    await Promise.all(channels.map((channel) => channel.closed));
    expect(secondWire.closes).toBe(1);
    expect(tunnels.size()).toBe(0);
  });
});
