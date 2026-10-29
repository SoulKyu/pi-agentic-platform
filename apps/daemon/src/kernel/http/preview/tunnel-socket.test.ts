import { once } from "node:events";
import { TUNNEL_FRAME_BYTES, TUNNEL_WINDOW_BYTES, type TunnelFrame } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import type { BoxTunnelChannel } from "../../boxes.ts";
import { TUNNEL_RECEIVE_LIMIT, tunnelSocket, TunnelWindowBroken } from "./tunnel-socket.ts";

function fakeChannel() {
  const sent: TunnelFrame[] = [];
  let listener: ((frame: TunnelFrame) => void) | undefined;
  let finish: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let open = true;
  let closeCalls = 0;
  const channel: BoxTunnelChannel = {
    send(frame) {
      if (!open) return false;
      sent.push(frame);
      return true;
    },
    onFrame(next) {
      listener = next;
    },
    closed,
    close() {
      closeCalls++;
      open = false;
      finish();
    },
  };
  return {
    channel,
    sent,
    deliver: (frame: TunnelFrame) => listener?.(frame),
    closeCalls: () => closeCalls,
    guestGone() {
      open = false;
      finish();
    },
    dataFrames: () => sent.filter((frame) => frame.type === "tunnel_data"),
    acks: () => sent.filter((frame) => frame.type === "tunnel_ack").map((frame) => frame.bytes),
  };
}

const data = (bytes: number): TunnelFrame => ({
  type: "tunnel_data",
  data: Buffer.alloc(bytes, 1).toString("base64"),
});
const rawOf = (frame: TunnelFrame): number =>
  frame.type === "tunnel_data" ? Buffer.from(frame.data, "base64").length : 0;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("tunnelSocket receiving", () => {
  it("a guest that sends 2 MiB without an ack has its tunnel destroyed and nothing buffered past the window", async () => {
    const fake = fakeChannel();
    const socket = tunnelSocket(fake.channel);
    const errors: Error[] = [];
    socket.on("error", (error) => void errors.push(error));
    let peak = 0;
    for (let sent = 0; sent < 2 * 1024 * 1024; sent += TUNNEL_FRAME_BYTES) {
      fake.deliver(data(TUNNEL_FRAME_BYTES));
      peak = Math.max(peak, socket.readableLength);
    }
    await flush();
    expect(peak).toBeLessThanOrEqual(TUNNEL_RECEIVE_LIMIT);
    expect(socket.destroyed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TunnelWindowBroken);
    expect(fake.closeCalls()).toBe(1);
  });

  it("a well-behaved guest at the edge of its window (window - 1, then one full frame) is never cut", async () => {
    const fake = fakeChannel();
    const socket = tunnelSocket(fake.channel);
    socket.on("error", () => {});
    for (let n = 0; n < TUNNEL_WINDOW_BYTES / TUNNEL_FRAME_BYTES - 1; n++)
      fake.deliver(data(TUNNEL_FRAME_BYTES));
    fake.deliver(data(TUNNEL_FRAME_BYTES - 1));
    fake.deliver(data(TUNNEL_FRAME_BYTES));
    await flush();
    expect(socket.destroyed).toBe(false);
    expect(socket.readableLength).toBe(TUNNEL_RECEIVE_LIMIT - 1);
  });

  it("received data is acknowledged as it is read, not while push is refused", async () => {
    const fake = fakeChannel();
    const socket = tunnelSocket(fake.channel);
    fake.deliver(data(10));
    expect(fake.acks()).toEqual([10]);
    fake.deliver(data(TUNNEL_FRAME_BYTES));
    await flush();
    expect(fake.acks()).toEqual([10]);
    socket.read();
    expect(fake.acks()).toEqual([10, 10 + TUNNEL_FRAME_BYTES]);
  });
});

describe("tunnelSocket sending", () => {
  it("a 200 KiB write goes out as 64 KiB frames, and past 1 MiB unacknowledged the rest waits for an ack", async () => {
    const fake = fakeChannel();
    const socket = tunnelSocket(fake.channel);
    const done = new Promise<void>((resolve) => socket.write(Buffer.alloc(200 * 1024, 2), () => resolve()));
    await done;
    expect(fake.dataFrames().map(rawOf)).toEqual([65536, 65536, 65536, 8192]);

    let finished = false;
    socket.write(Buffer.alloc(2 * 1024 * 1024, 3), () => void (finished = true));
    await flush();
    const sentBytes = () => fake.dataFrames().reduce((total, frame) => total + rawOf(frame), 0);
    expect(sentBytes()).toBeGreaterThanOrEqual(TUNNEL_WINDOW_BYTES);
    expect(sentBytes()).toBeLessThan(TUNNEL_WINDOW_BYTES + TUNNEL_FRAME_BYTES);
    expect(finished).toBe(false);
    const stalled = sentBytes();
    fake.deliver({ type: "tunnel_ack", bytes: stalled });
    await flush();
    expect(sentBytes()).toBeGreaterThan(stalled);
    expect(sentBytes() - stalled).toBeLessThanOrEqual(TUNNEL_WINDOW_BYTES + TUNNEL_FRAME_BYTES);
  });

  it("an ack beyond what was sent destroys the socket", async () => {
    const fake = fakeChannel();
    const socket = tunnelSocket(fake.channel);
    const errors: Error[] = [];
    socket.on("error", (error) => void errors.push(error));
    fake.deliver({ type: "tunnel_ack", bytes: 1 });
    await flush();
    expect(socket.destroyed).toBe(true);
    expect(errors[0]).toBeInstanceOf(TunnelWindowBroken);
    expect(fake.closeCalls()).toBe(1);
  });
});

describe("tunnelSocket ending", () => {
  it("end sends tunnel_end; after the guest's tunnel_end and close, what it sent is still read", async () => {
    const fake = fakeChannel();
    const socket = tunnelSocket(fake.channel);
    socket.end();
    await flush();
    expect(fake.sent).toContainEqual({ type: "tunnel_end" });

    const fresh = fakeChannel();
    const reading = tunnelSocket(fresh.channel);
    fresh.deliver({ type: "tunnel_data", data: Buffer.from("hello").toString("base64") });
    fresh.deliver({ type: "tunnel_end" });
    fresh.guestGone();
    await flush();
    expect(reading.destroyed).toBe(false);
    const chunks: Buffer[] = [];
    reading.on("data", (chunk: Buffer) => void chunks.push(chunk));
    await once(reading, "close");
    expect(Buffer.concat(chunks).toString()).toBe("hello");
  });

  it("the guest going away mid-answer destroys the socket at once", async () => {
    const fake = fakeChannel();
    const socket = tunnelSocket(fake.channel);
    fake.deliver(data(10));
    fake.guestGone();
    await flush();
    expect(socket.destroyed).toBe(true);
  });
});
