import { EventEmitter, once } from "node:events";
import type { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { PROTOCOL_VERSION, type Caller } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../clock.ts";
import { silentLogger } from "../logger.ts";
import type { OriginRefused } from "../http/origin.ts";
import { createStreamHub } from "./stream-hub.ts";
import { createWsServer, KEEPALIVE_MS, startKeepalive } from "./ws-server.ts";
import { testCaller } from "../../testing/caller.ts";

class FakePeer extends EventEmitter {
  ping = vi.fn();
  terminate = vi.fn();
}

describe("keepalive", () => {
  it("pings at once and terminates a peer that stays silent for a whole window", async () => {
    const clock = createFakeClock();
    const peer = new FakePeer();
    startKeepalive(peer, clock);
    expect(peer.ping).toHaveBeenCalledTimes(1);
    await clock.advance(KEEPALIVE_MS - 1);
    expect(peer.terminate).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(peer.terminate).toHaveBeenCalledTimes(1);
    expect(peer.ping).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  it.each(["message", "ping", "pong"])(
    "a %s keeps the peer alive and the server pings every window",
    async (event) => {
      const clock = createFakeClock();
      const peer = new FakePeer();
      startKeepalive(peer, clock);
      for (let window = 0; window < 4; window++) {
        peer.emit(event);
        await clock.advance(KEEPALIVE_MS);
      }
      expect(peer.terminate).not.toHaveBeenCalled();
      expect(peer.ping).toHaveBeenCalledTimes(5);
    },
  );

  it("terminates a peer that answered the first ping and then went silent", async () => {
    const clock = createFakeClock();
    const peer = new FakePeer();
    startKeepalive(peer, clock);
    peer.emit("pong");
    await clock.advance(KEEPALIVE_MS);
    expect(peer.terminate).not.toHaveBeenCalled();
    await clock.advance(KEEPALIVE_MS);
    expect(peer.terminate).toHaveBeenCalledTimes(1);
  });

  it("stop cancels the pending deadline", async () => {
    const clock = createFakeClock();
    const peer = new FakePeer();
    startKeepalive(peer, clock).stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(10 * KEEPALIVE_MS);
    expect(peer.terminate).not.toHaveBeenCalled();
  });

  it("runs onWindow at the end of every window a live peer survived, not at the start", async () => {
    const clock = createFakeClock();
    const peer = new FakePeer();
    const onWindow = vi.fn();
    startKeepalive(peer, clock, onWindow);
    expect(onWindow).not.toHaveBeenCalled();
    peer.emit("pong");
    await clock.advance(KEEPALIVE_MS);
    expect(onWindow).toHaveBeenCalledTimes(1);
    await clock.advance(KEEPALIVE_MS);
    expect(onWindow).toHaveBeenCalledTimes(1);
    expect(peer.terminate).toHaveBeenCalledTimes(1);
  });

  it("stops pinging once onWindow stopped the chain", async () => {
    const clock = createFakeClock();
    const peer = new FakePeer();
    const keepalive = startKeepalive(peer, clock, () => keepalive.stop());
    peer.emit("pong");
    await clock.advance(KEEPALIVE_MS);
    expect(peer.ping).toHaveBeenCalledTimes(1);
    expect(clock.pending()).toBe(0);
  });

  it("terminates instead of throwing out of the timer when a ping fails", async () => {
    const clock = createFakeClock();
    const peer = new FakePeer();
    startKeepalive(peer, clock);
    peer.ping.mockImplementation(() => {
      throw new Error("not open");
    });
    peer.emit("pong");
    await clock.advance(KEEPALIVE_MS);
    expect(peer.terminate).toHaveBeenCalledTimes(1);
  });
});

const owner: Caller = testCaller();

function refusalSetup(authenticate: () => Caller | null = () => owner, onOriginRefused?: OriginRefused) {
  const server = createWsServer({
    allowedOrigins: new Set(["http://localhost:7777"]),
    ...(onOriginRefused ? { onOriginRefused } : {}),
    credentialOf: (header) => header,
    authenticate,
    dispatch: () => Promise.reject(new Error("unused")),
    hub: createStreamHub("e"),
    logger: silentLogger,
    clock: createFakeClock(),
    serverVersion: "0.0.0-test",
  });
  const written: string[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk.toString());
      done();
    },
  });
  const destroy = vi.spyOn(socket, "destroy");
  const upgrade = (url: string, origin: string | undefined = "http://localhost:7777") =>
    server.handleUpgrade({ url, headers: { origin } } as unknown as IncomingMessage, socket, Buffer.alloc(0));
  return { upgrade, socket, destroy, written };
}

describe("upgrade refusals (R8)", () => {
  it.each([
    ["/ws?proto=0", "http://localhost:7777", "426 Upgrade Required"],
    [`/ws?proto=${PROTOCOL_VERSION}`, "http://evil.example", "403 Forbidden"],
    [`/nope?proto=${PROTOCOL_VERSION}`, "http://localhost:7777", "404 Not Found"],
  ])(
    "writes %s to %s as %s and destroys the socket only after it was flushed",
    async (url, origin, status) => {
      const { upgrade, socket, destroy, written } = refusalSetup();
      upgrade(url, origin);
      expect(destroy).not.toHaveBeenCalled();
      await once(socket, "finish");
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(written.join("")).toBe(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    },
  );

  it("tells the caller which Origin it refused, and nothing for the other refusals", async () => {
    const refused: Array<[string, string | undefined]> = [];
    const { upgrade, socket } = refusalSetup(undefined, (via, origin) => refused.push([via, origin]));
    upgrade(`/ws?proto=${PROTOCOL_VERSION}`, "http://evil.example");
    await once(socket, "finish");
    upgrade("/ws?proto=0");
    upgrade(`/nope?proto=${PROTOCOL_VERSION}`);
    expect(refused).toEqual([["ws", "http://evil.example"]]);
  });

  it("answers 401 for an unauthenticated caller and 500 when authentication throws", async () => {
    const anonymous = refusalSetup(() => null);
    anonymous.upgrade(`/ws?proto=${PROTOCOL_VERSION}`);
    await once(anonymous.socket, "finish");
    expect(anonymous.written.join("")).toContain("401 Unauthorized");

    const broken = refusalSetup(() => {
      throw new Error("database is locked");
    });
    broken.upgrade(`/ws?proto=${PROTOCOL_VERSION}`);
    await once(broken.socket, "finish");
    expect(broken.written.join("")).toContain("500 Internal Server Error");
  });

  it("answers 400 for an unparsable request target", async () => {
    const { upgrade, socket, written } = refusalSetup();
    upgrade("http://[");
    await once(socket, "finish");
    expect(written.join("")).toContain("400 Bad Request");
  });

  it("swallows a socket error while refusing instead of crashing the process", () => {
    const { upgrade, socket, destroy } = refusalSetup();
    upgrade("/ws?proto=0");
    expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
    expect(destroy).toHaveBeenCalled();
  });
});
