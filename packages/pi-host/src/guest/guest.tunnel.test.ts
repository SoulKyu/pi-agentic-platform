import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  createFrameDecoder,
  encodeSocketFrame,
  AGENT_VM_PROTOCOL,
} from "@pap/contracts/pi-host";
import { SLOT, start, TOKEN } from "../testing/guest-harness.ts";
import { TUNNEL_REFUSAL } from "./services/tunnels.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

/** A second gateway port for side connections: what the guest says on it and a way to talk back. */
async function sidePort() {
  const frames: unknown[] = [];
  let peer: net.Socket | undefined;
  const server = net.createServer((socket) => {
    peer = socket;
    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (frame) => void frames.push(frame),
      onError: () => undefined,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    peer?.destroy();
    server.close();
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    frames,
    send: (frame: unknown) => void peer?.write(encodeSocketFrame(frame)),
  };
}

describe("runGuest tunnel_open", () => {
  it("connects to the service, says a tunnel hello on a new connection and splices", async () => {
    const side = await sidePort();
    const serviceEnd = await sidePort();
    const asked: string[] = [];
    let first = true;
    const run = await start((gateway) => ({
      connect: () => {
        if (first) {
          first = false;
          return net.connect(gateway.port, "127.0.0.1");
        }
        return net.connect(side.port, "127.0.0.1");
      },
      services: () => ({
        op: () => Promise.reject(new Error("unused")),
        closeAll: () => undefined,
        connectTo: (id) => {
          asked.push(id);
          return Promise.resolve(net.connect(serviceEnd.port, "127.0.0.1"));
        },
      }),
    }));
    await run.hello();
    run.gateway.send({ type: "tunnel_open", slot: SLOT, service: "a".repeat(32) });
    await vi.waitFor(() => expect(side.frames).toHaveLength(1));
    expect(asked).toEqual(["a".repeat(32)]);
    expect(side.frames[0]).toMatchObject({
      type: "hello",
      role: "tunnel",
      slot: SLOT,
      token: TOKEN,
      protocol: AGENT_VM_PROTOCOL,
    });
    side.send({ type: "tunnel_data", data: Buffer.from("hi").toString("base64") });
    await vi.waitFor(() => expect(side.frames).toContainEqual({ type: "tunnel_ack", bytes: 2 }));
  });

  it("tells the daemon the slot could not open with one fixed sentence", async () => {
    const run = await start({
      services: () => ({
        op: () => Promise.reject(new Error("unused")),
        closeAll: () => undefined,
        connectTo: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9999")),
      }),
    });
    await run.hello();
    run.gateway.send({ type: "tunnel_open", slot: SLOT, service: "a".repeat(32) });
    await vi.waitFor(() =>
      expect(run.gateway.frames).toContainEqual({
        type: "exited",
        slot: SLOT,
        code: 1,
        signal: null,
        tail: `pap-guest: ${TUNNEL_REFUSAL}`,
      }),
    );
  });

  it("a guest without services refuses the slot the same way", async () => {
    const run = await start();
    await run.hello();
    run.gateway.send({ type: "tunnel_open", slot: SLOT, service: "a".repeat(32) });
    await vi.waitFor(() =>
      expect(run.gateway.frames).toContainEqual(expect.objectContaining({ type: "exited", slot: SLOT })),
    );
  });

  it("closes every tunnel when the guest ends", async () => {
    const side = await sidePort();
    let service: net.Socket | undefined;
    const serviceEnd = await sidePort();
    let first = true;
    const run = await start((gateway) => ({
      connect: () => {
        if (first) {
          first = false;
          return net.connect(gateway.port, "127.0.0.1");
        }
        return net.connect(side.port, "127.0.0.1");
      },
      services: () => ({
        op: () => Promise.reject(new Error("unused")),
        closeAll: () => undefined,
        connectTo: () => {
          service = net.connect(serviceEnd.port, "127.0.0.1");
          return Promise.resolve(service);
        },
      }),
    }));
    await run.hello();
    run.gateway.send({ type: "tunnel_open", slot: SLOT, service: "a".repeat(32) });
    await vi.waitFor(() => expect(side.frames).toHaveLength(1));
    run.gateway.send({ type: "shutdown" });
    await vi.waitFor(() => expect(service?.destroyed).toBe(true));
    await run.done;
  });
});
