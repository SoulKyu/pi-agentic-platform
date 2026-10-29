import net from "node:net";
import { Duplex } from "node:stream";
import { afterEach } from "vitest";
import { AGENT_VM_MAX_FRAME_BYTES, createFrameDecoder, encodeSocketFrame } from "@pap/contracts/pi-host";
import { createTunnelHost, type TunnelHostDeps } from "./tunnels.ts";

export const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

export const b64 = (text: string): string => Buffer.from(text).toString("base64");

/** An in-memory socket: `written` is what the host wrote to it, `feed` what it hands the host. */
export function memory() {
  const written: Buffer[] = [];
  let ended = false;
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk);
      done();
    },
    final(done) {
      ended = true;
      done();
    },
  });
  socket.on("error", () => undefined);
  return {
    socket: socket as unknown as net.Socket,
    duplex: socket,
    feed: (bytes: Buffer | string) => void socket.push(bytes),
    finish: () => void socket.push(null),
    written: () => Buffer.concat(written),
    ended: () => ended,
  };
}

/** What the side connection received, decoded; `send` writes a frame as the daemon would. */
export function daemonEnd(side: ReturnType<typeof memory>) {
  const frames: Array<Record<string, unknown>> = [];
  let consumed = 0;
  const decoder = createFrameDecoder({
    maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
    onFrame: (frame) => void frames.push(frame as Record<string, unknown>),
    onError: () => undefined,
  });
  const read = (): void => {
    const all = side.written();
    if (all.length > consumed) decoder.push(all.subarray(consumed));
    consumed = all.length;
  };
  return {
    frames: () => {
      read();
      return frames;
    },
    send: (frame: unknown) => void side.feed(encodeSocketFrame(frame)),
  };
}

export function bed(over: Partial<TunnelHostDeps> = {}) {
  const refused: Array<[string, string]> = [];
  const logs: string[] = [];
  const sides: Array<ReturnType<typeof memory>> = [];
  const services: Array<ReturnType<typeof memory>> = [];
  const deps: TunnelHostDeps = {
    services: {
      connectTo: () => {
        const service = memory();
        services.push(service);
        return Promise.resolve(service.socket);
      },
    },
    side: () => {
      const side = memory();
      sides.push(side);
      return Promise.resolve(side.socket);
    },
    refuse: (slot, why) => void refused.push([slot, why]),
    log: (line) => void logs.push(line),
    ...over,
  };
  const host = createTunnelHost(deps);
  cleanups.push(() => host.closeAll());
  return { host, refused, logs, sides, services };
}

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
