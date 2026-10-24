import { createServer as createHttp } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { EGRESS_LIMITS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { loopbackVmSeams } from "./testing/vm.ts";
import { createVmEgress, type VmScope } from "./vm-listener.ts";

/** The bounds and anti-rebinding behaviour of the proxy core as the VM listener runs it (ported from the host proxy tests). Loopback only. */
const VM = "127.0.0.9";
const GET = "GET http://api.example.test/ HTTP/1.1\r\nHost: x\r\n\r\n";
const connectLine = (target: string): string => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
const listening = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );
const closedOf = (socket: Socket): Promise<void> =>
  new Promise((resolve) => (socket.destroyed ? resolve() : socket.once("close", () => resolve())));
const nextData = (socket: Socket): Promise<string> =>
  new Promise((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
const statusOf = (reply: string): string => reply.split("\r\n", 1)[0] ?? "";

function dial(port: number, payload: string): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, localAddress: VM });
    socket.on("error", () => {});
    socket.once("connect", () => {
      if (payload !== "") socket.write(payload);
      resolve(socket);
    });
  });
}
const readAll = (socket: Socket): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
const tunnel = async (port: number): Promise<Socket> => {
  const socket = await dial(port, connectLine("api.example.test:443"));
  await new Promise<void>((resolve) => {
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString();
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve();
    };
    socket.on("data", onData);
  });
  return socket;
};

describe("the VM egress listener keeps the proxy core's bounds", () => {
  let echo: Server;
  let origin: ReturnType<typeof createHttp>;
  let sockets: Set<Socket>;
  let clock: FakeClock;
  let seams: ReturnType<typeof loopbackVmSeams>;
  let port: number;
  let egress: ReturnType<typeof createVmEgress>;
  let resolveAs: (() => Promise<readonly string[]>) | null;
  let seen: string[];

  const scope: VmScope = {
    box: { kind: "agent", id: "atlas-1a2b" },
    launchId: "launch-a",
    source: "thread",
    hosts: ["api.example.test"],
    trustedSources: [],
  };

  beforeEach(async () => {
    sockets = new Set();
    seen = [];
    resolveAs = null;
    echo = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.pipe(socket);
    });
    origin = createHttp((req) => {
      seen.push(req.url ?? ""); // never answers: a request that reaches the origin stays open
    });
    const dead = createServer();
    const deadPort = await listening(dead);
    await new Promise((resolve) => dead.close(resolve));
    const echoPort = await listening(echo);
    const originPort = await listening(origin);
    // 127.7.0.1 is api.example.test; 127.7.0.2 is a loopback port nobody listens on.
    seams = loopbackVmSeams({
      "api.example.test": { 80: originPort, 443: echoPort },
      "dead.example.test": { 80: deadPort, 443: deadPort },
    });
    clock = createFakeClock();
    egress = createVmEgress({
      clock,
      logger: captureLogger().logger,
      ...seams,
      resolve: (host) => (resolveAs ? resolveAs() : seams.resolve(host)),
      scopeOf: (address) => (address === VM ? scope : null),
      onRefusal: () => {},
    });
    port = await egress.listen("127.0.0.1", 0);
  });

  afterEach(async () => {
    await egress.close();
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections();
    await Promise.all([new Promise((r) => echo.close(r)), new Promise((r) => origin.close(r))]);
  });

  it("answers 431 to a request head past 16 KiB, and reaches nothing", async () => {
    const pad = `X-Pad: ${"a".repeat(17 * 1024)}\r\n`;
    const reply = await readAll(
      await dial(port, `GET http://api.example.test/ HTTP/1.1\r\nHost: x\r\n${pad}\r\n`),
    );
    expect(statusOf(reply)).toBe("HTTP/1.1 431 Request Header Fields Too Large");
    expect(seen).toEqual([]);
    expect(seams.calls.resolve).toEqual([]);
  });

  it("closes a connection whose head is slower than 10 s", async () => {
    const socket = await dial(port, "GET http://api.example.test/ HTT");
    await clock.advance(EGRESS_LIMITS.headMs - 1);
    expect(socket.destroyed).toBe(false);
    await clock.advance(2);
    await closedOf(socket);
    expect(seams.calls.resolve).toEqual([]);
  });

  it("closes an idle tunnel after 120 s, and activity postpones it", async () => {
    const socket = await tunnel(port);
    await clock.advance(EGRESS_LIMITS.idleMs - 1000);
    const echoed = nextData(socket);
    socket.write("alive");
    expect(await echoed).toBe("alive");
    await clock.advance(EGRESS_LIMITS.idleMs - 1000);
    expect(socket.destroyed).toBe(false);
    await clock.advance(1001);
    await closedOf(socket);
  });

  it("closes a connection past its time cap even while it is busy", async () => {
    const socket = await tunnel(port);
    for (let elapsed = 0; elapsed + 100_000 < EGRESS_LIMITS.connectionMs; elapsed += 100_000) {
      await clock.advance(100_000);
      const echoed = nextData(socket);
      socket.write("x");
      expect(await echoed).toBe("x");
    }
    expect(socket.destroyed).toBe(false);
    await clock.advance(200_000);
    await closedOf(socket);
  });

  it("100 pipelined requests open one upstream", async () => {
    const socket = await dial(port, GET.repeat(100));
    await closedOf(socket); // the second request on the connection ends it
    expect(seams.calls.connect).toHaveLength(1);
  });

  it("GET then CONNECT on one connection opens one upstream", async () => {
    const socket = await dial(port, GET + connectLine("api.example.test:443"));
    await closedOf(socket);
    expect(seams.calls.connect).toEqual([{ ip: "127.7.0.1", port: 80 }]);
  });

  it("tries every checked answer in order: a first address that refuses falls through to the next", async () => {
    resolveAs = async () => ["127.7.0.2", "127.7.0.1"];
    const socket = await tunnel(port);
    const echoed = nextData(socket);
    socket.write("ping");
    expect(await echoed).toBe("ping");
    expect(seams.calls.connect).toEqual([
      { ip: "127.7.0.2", port: 443 },
      { ip: "127.7.0.1", port: 443 },
    ]);
    socket.destroy();
  });

  it("answers 502 once every answer has failed", async () => {
    resolveAs = async () => ["127.7.0.2", "127.7.0.9"];
    const reply = await readAll(await dial(port, connectLine("api.example.test:443")));
    expect(statusOf(reply)).toBe("HTTP/1.1 502 Bad Gateway");
    expect(seams.calls.connect.map((call) => call.ip)).toEqual(["127.7.0.2", "127.7.0.9"]);
  });
});
