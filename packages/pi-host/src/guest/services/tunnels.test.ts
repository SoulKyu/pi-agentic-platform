import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  createFrameDecoder,
  encodeSocketFrame,
  TUNNEL_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
} from "@pap/contracts/pi-host";
import { SLOT, SLOT_B } from "../../testing/guest-harness.ts";
import { TUNNEL_REFUSAL, TUNNELS_PER_GUEST } from "./tunnels.ts";
import { b64, bed, cleanups, daemonEnd, memory, settle } from "./tunnels.rig.ts";

// Mutants, each killed by the case named:
//  - a `ping` parsed as a tunnel frame                    -> "a tunnel open for 60 s answers four pings and stays up"
//  - an ended tunnel kept in the map                      -> "10 000 tunnels opened and closed leave 0 entries"
//  - no send window                                       -> "stops reading the service past 1 MiB ..."
//  - `tunnel_end` before the data                         -> "stops reading the service past 1 MiB ..."
//  - the service socket never paused                      -> "stops reading the service past 1 MiB ..."
//  - an ack beyond what was sent accepted                 -> "an ack beyond what was sent ends the tunnel"
//  - the refusal carries the error                        -> "a refused open tells the daemon one fixed sentence ..."
//  - no cap on open tunnels                               -> "the 65th tunnel is refused"

describe("the guest's tunnels", () => {
  it("opens the side connection only after the service accepted, and splices bytes both ways", async () => {
    let accept: (socket: net.Socket) => void = () => undefined;
    const order: string[] = [];
    const service = memory();
    const sides: Array<ReturnType<typeof memory>> = [];
    const t = bed({
      services: {
        connectTo: (id) => {
          order.push(`connect ${id}`);
          return new Promise((resolve) => {
            accept = resolve;
          });
        },
      },
      side: (slot) => {
        order.push(`side ${slot}`);
        const side = memory();
        sides.push(side);
        return Promise.resolve(side.socket);
      },
    });
    t.host.open({ slot: SLOT, service: "svc" });
    await settle();
    expect(order).toEqual(["connect svc"]);
    accept(service.socket);
    await vi.waitFor(() => expect(sides).toHaveLength(1));
    expect(order).toEqual(["connect svc", `side ${SLOT}`]);

    const daemon = daemonEnd(sides[0] as ReturnType<typeof memory>);
    daemon.send({ type: "tunnel_data", data: b64("GET / HTTP/1.1\r\n\r\n") });
    await vi.waitFor(() => expect(service.written().toString()).toBe("GET / HTTP/1.1\r\n\r\n"));
    await vi.waitFor(() => expect(daemon.frames()).toContainEqual({ type: "tunnel_ack", bytes: 18 }));

    service.feed("HTTP/1.1 200 OK\r\n\r\n");
    await vi.waitFor(() =>
      expect(daemon.frames()).toContainEqual({ type: "tunnel_data", data: b64("HTTP/1.1 200 OK\r\n\r\n") }),
    );

    daemon.send({ type: "tunnel_end" });
    await vi.waitFor(() => expect(service.ended()).toBe(true));
    service.duplex.destroy();
    // The service closed: its data and tunnel_end are out and the side is ended; the daemon then closes its end.
    await vi.waitFor(() => expect(sides[0]?.ended()).toBe(true));
    sides[0]?.finish();
    await vi.waitFor(() => expect(t.host.size()).toBe(0));
    expect(sides[0]?.duplex.destroyed).toBe(true);
  });

  it("a service that is not running, or a port no longer owned, refuses the slot with a fixed sentence", async () => {
    const t = bed({
      services: {
        connectTo: (id) =>
          Promise.reject(
            new Error(
              id === "a" ? "service is not running" : "service port is not owned by 127.0.0.1:8000 errno 111",
            ),
          ),
      },
    });
    t.host.open({ slot: SLOT, service: "a" });
    t.host.open({ slot: SLOT_B, service: "b" });
    await vi.waitFor(() => expect(t.refused).toHaveLength(2));
    expect(t.refused).toEqual([
      [SLOT, TUNNEL_REFUSAL],
      [SLOT_B, TUNNEL_REFUSAL],
    ]);
    expect(t.sides).toHaveLength(0);
    expect(t.host.size()).toBe(0);
  });

  it("a refused open tells the daemon one fixed sentence, never the error", async () => {
    const secret = "connect ECONNREFUSED 10.213.0.9:8123 /home/agent/secret";
    const t = bed({ services: { connectTo: () => Promise.reject(new Error(secret)) } });
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.refused).toHaveLength(1));
    expect(t.refused[0]).toEqual([SLOT, "the service is not running or does not own its port"]);
    expect(TUNNEL_REFUSAL).toBe("the service is not running or does not own its port");
    expect(t.logs.join("\n")).not.toContain("10.213.0.9");
    expect(t.logs.join("\n")).not.toContain("secret");
  });

  it("a tunnel open for 60 s answers four pings and stays up", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
    const sideEnd = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
    const daemonSocket = await accepted;
    cleanups.push(() => {
      sideEnd.destroy();
      daemonSocket.destroy();
      server.close();
    });
    const received: Array<Record<string, unknown>> = [];
    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (frame) => void received.push(frame as Record<string, unknown>),
      onError: () => undefined,
    });
    daemonSocket.on("data", (chunk) => decoder.push(chunk));
    const service = memory();
    const t = bed({
      services: { connectTo: () => Promise.resolve(service.socket) },
      side: () => Promise.resolve(sideEnd),
    });
    t.host.open({ slot: SLOT, service: "svc" });
    await settle();

    // The gateway pings every 15 s: four pings are 60 s. Each one is answered, and no answer is a tunnel frame.
    for (let ping = 1; ping <= 4; ping++) {
      daemonSocket.write(encodeSocketFrame({ type: "ping" }));
      await vi.waitFor(() => expect(received.filter((frame) => frame.type === "pong")).toHaveLength(ping));
    }
    expect(t.host.size()).toBe(1);
    expect(sideEnd.destroyed).toBe(false);

    daemonSocket.write(encodeSocketFrame({ type: "tunnel_data", data: b64("hello") }));
    await vi.waitFor(() => expect(service.written().toString()).toBe("hello"));
    await vi.waitFor(() => expect(received).toContainEqual({ type: "tunnel_ack", bytes: 5 }));
    expect(t.logs).toEqual([]);
  });

  it("10 000 tunnels opened and closed leave 0 entries", async () => {
    const t = bed();
    let most = 0;
    for (let n = 0; n < 10_000; n++) {
      const slot = n.toString(16).padStart(32, "0");
      t.host.open({ slot, service: "svc" });
      most = Math.max(most, t.host.size());
      for (let turn = 0; turn < 20 && t.sides.length === 0; turn++) await Promise.resolve();
      t.sides.at(-1)?.duplex.destroy();
      t.sides.length = 0;
      t.services.length = 0;
      if (n % 500 === 499) await settle();
    }
    await vi.waitFor(() => expect(t.host.size()).toBe(0));
    expect(most).toBeLessThan(TUNNELS_PER_GUEST);
  });

  it("stops reading the service past 1 MiB unacknowledged and sends tunnel_end only after its data", async () => {
    const t = bed();
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.sides).toHaveLength(1));
    const service = t.services[0] as ReturnType<typeof memory>;
    const daemon = daemonEnd(t.sides[0] as ReturnType<typeof memory>);
    const total = 2 * TUNNEL_WINDOW_BYTES;
    service.feed(Buffer.alloc(total, 0x61));
    service.finish();

    const dataBytes = (): number =>
      daemon
        .frames()
        .filter((frame) => frame.type === "tunnel_data")
        .reduce((sum, frame) => sum + Buffer.from(frame.data as string, "base64").length, 0);
    await vi.waitFor(() => expect(dataBytes()).toBeGreaterThan(0));
    await settle();
    expect(dataBytes()).toBeLessThanOrEqual(TUNNEL_WINDOW_BYTES + TUNNEL_FRAME_BYTES);
    expect(dataBytes()).toBe(TUNNEL_WINDOW_BYTES);
    expect(service.duplex.isPaused()).toBe(true);
    expect(daemon.frames().some((frame) => frame.type === "tunnel_end")).toBe(false);
    for (const frame of daemon.frames())
      if (frame.type === "tunnel_data")
        expect(Buffer.from(frame.data as string, "base64").length).toBeLessThanOrEqual(TUNNEL_FRAME_BYTES);

    daemon.send({ type: "tunnel_ack", bytes: TUNNEL_WINDOW_BYTES });
    await vi.waitFor(() => expect(dataBytes()).toBe(total));
    await settle();
    // Every byte is out, half of it still unacknowledged: the service stays paused and its end is not read yet.
    expect(daemon.frames().some((frame) => frame.type === "tunnel_end")).toBe(false);
    expect(service.duplex.isPaused()).toBe(true);

    daemon.send({ type: "tunnel_ack", bytes: total });
    await vi.waitFor(() => expect(daemon.frames().some((frame) => frame.type === "tunnel_end")).toBe(true));
    const types = daemon.frames().map((frame) => frame.type);
    expect(types.lastIndexOf("tunnel_data")).toBeLessThan(types.indexOf("tunnel_end"));
    expect(types.filter((type) => type === "tunnel_end")).toHaveLength(1);
  });

  it("a service that closes while data is held sends tunnel_end after every byte, as the acks free the window", async () => {
    const t = bed();
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.sides).toHaveLength(1));
    const service = t.services[0] as ReturnType<typeof memory>;
    const daemon = daemonEnd(t.sides[0] as ReturnType<typeof memory>);
    const total = 2 * TUNNEL_WINDOW_BYTES;
    const dataBytes = (): number =>
      daemon
        .frames()
        .filter((frame) => frame.type === "tunnel_data")
        .reduce((sum, frame) => sum + Buffer.from(frame.data as string, "base64").length, 0);
    service.feed(Buffer.alloc(total, 0x62));
    await vi.waitFor(() => expect(dataBytes()).toBe(TUNNEL_WINDOW_BYTES));
    service.duplex.destroy();
    await settle();
    expect(daemon.frames().some((frame) => frame.type === "tunnel_end")).toBe(false);
    expect(t.sides[0]?.ended()).toBe(false);

    daemon.send({ type: "tunnel_ack", bytes: TUNNEL_WINDOW_BYTES });
    await vi.waitFor(() => expect(t.sides[0]?.ended()).toBe(true));
    expect(dataBytes()).toBe(total);
    const types = daemon.frames().map((frame) => frame.type);
    expect(types.at(-1)).toBe("tunnel_end");
    expect(types.filter((type) => type === "tunnel_end")).toHaveLength(1);
  });

  it("an ack beyond what was sent ends the tunnel", async () => {
    const t = bed();
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.sides).toHaveLength(1));
    const daemon = daemonEnd(t.sides[0] as ReturnType<typeof memory>);
    t.services[0]?.feed("12345");
    await vi.waitFor(() => expect(daemon.frames()).toHaveLength(1));
    daemon.send({ type: "tunnel_ack", bytes: 6 });
    await vi.waitFor(() => expect(t.sides[0]?.duplex.destroyed).toBe(true));
    expect(t.services[0]?.duplex.destroyed).toBe(true);
    expect(t.host.size()).toBe(0);
    expect(t.logs.join("\n")).toContain("acknowledged more than it was sent");
  });

  it("a malformed frame ends both sockets", async () => {
    const t = bed();
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.sides).toHaveLength(1));
    daemonEnd(t.sides[0] as ReturnType<typeof memory>).send({ type: "tunnel_data", data: "!!" });
    await vi.waitFor(() => expect(t.services[0]?.duplex.destroyed).toBe(true));
    expect(t.sides[0]?.duplex.destroyed).toBe(true);
    expect(t.host.size()).toBe(0);
  });

  it("the service closing ends the side once its data and tunnel_end are out", async () => {
    const t = bed();
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.sides).toHaveLength(1));
    const daemon = daemonEnd(t.sides[0] as ReturnType<typeof memory>);
    const service = t.services[0] as ReturnType<typeof memory>;
    service.feed("bye");
    service.duplex.destroy();
    await vi.waitFor(() => expect(t.sides[0]?.ended()).toBe(true));
    expect(daemon.frames().map((frame) => frame.type)).toEqual(["tunnel_data", "tunnel_end"]);
  });

  it("the 65th tunnel is refused", async () => {
    let connects = 0;
    const t = bed({
      services: {
        connectTo: () => {
          connects++;
          return new Promise(() => undefined);
        },
      },
    });
    for (let n = 0; n < TUNNELS_PER_GUEST + 1; n++)
      t.host.open({ slot: n.toString(16).padStart(32, "0"), service: "svc" });
    expect(connects).toBe(TUNNELS_PER_GUEST);
    expect(t.refused).toEqual([[TUNNELS_PER_GUEST.toString(16).padStart(32, "0"), TUNNEL_REFUSAL]]);
    expect(t.host.size()).toBe(TUNNELS_PER_GUEST);
  });

  it("ignores a second open of a slot that is open, and closeAll empties the map", async () => {
    const t = bed();
    t.host.open({ slot: SLOT, service: "svc" });
    t.host.open({ slot: SLOT, service: "svc" });
    await vi.waitFor(() => expect(t.sides).toHaveLength(1));
    expect(t.services).toHaveLength(1);
    expect(t.logs.join("\n")).toContain("it is open");
    t.host.closeAll();
    expect(t.host.size()).toBe(0);
    expect(t.services[0]?.duplex.destroyed).toBe(true);
    expect(t.sides[0]?.duplex.destroyed).toBe(true);
  });
});
