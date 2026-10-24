import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { loopbackVmSeams } from "./testing/vm.ts";
import { createVmEgress, type VmScope } from "./vm-listener.ts";

const VM = "127.0.0.9";

const dial = (port: number, payload: string): Promise<Socket> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, localAddress: VM });
    socket.on("error", () => {});
    socket.once("connect", () => {
      socket.write(payload);
      resolve(socket);
    });
  });
const readAll = (socket: Socket): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
  });
const established = (socket: Socket): Promise<string> =>
  new Promise((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
const connectLine = (target: string): string => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

describe("the VM egress listener tells the launch when content is not clean (spec 4)", () => {
  let echo: Server;
  let sockets: Set<Socket>;
  let tainted: Array<{ box: unknown; launchId: string }>;
  let egress: ReturnType<typeof createVmEgress>;
  let port: number;

  beforeEach(async () => {
    sockets = new Set();
    tainted = [];
    echo = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.pipe(socket);
    });
    const echoPort = await new Promise<number>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve((echo.address() as { port: number }).port)),
    );
    const seams = loopbackVmSeams({
      "docs.example.test": { 443: echoPort, 8443: echoPort },
      "feed.example.test": { 443: echoPort },
    });
    const scope: VmScope = {
      box: { kind: "agent", id: "atlas-1a2b" },
      launchId: "launch-a",
      source: "thread",
      hosts: ["docs.example.test", "docs.example.test:8443", "feed.example.test"],
      trustedSources: ["docs.example.test"],
    };
    egress = createVmEgress({
      clock: createFakeClock(),
      logger: captureLogger().logger,
      ...seams,
      scopeOf: (address) => (address === VM ? scope : null),
      onRefusal: () => {},
      onTaint: (launch) => void tainted.push(launch),
    });
    port = await egress.listen("127.0.0.1", 0);
  });

  afterEach(async () => {
    await egress.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => echo.close(resolve));
  });

  it("calls onTaint once per tunnel to a listed host that is not a trusted source", async () => {
    for (let n = 0; n < 2; n += 1) {
      const socket = await dial(port, connectLine("feed.example.test:443"));
      expect(await established(socket)).toMatch(/^HTTP\/1\.1 200/);
      socket.destroy();
    }
    expect(tainted).toEqual([
      { box: { kind: "agent", id: "atlas-1a2b" }, launchId: "launch-a" },
      { box: { kind: "agent", id: "atlas-1a2b" }, launchId: "launch-a" },
    ]);
  });

  it("does not call it for a CONNECT on 443 to a trusted source", async () => {
    const socket = await dial(port, connectLine("docs.example.test:443"));
    expect(await established(socket)).toMatch(/^HTTP\/1\.1 200/);
    socket.destroy();
    expect(tainted).toEqual([]);
  });

  it("calls it for a trusted source on another port", async () => {
    const socket = await dial(port, connectLine("docs.example.test:8443"));
    expect(await established(socket)).toMatch(/^HTTP\/1\.1 200/);
    socket.destroy();
    await vi.waitFor(() => expect(tainted).toHaveLength(1));
  });

  it("does not call it for a refused host", async () => {
    const socket = await dial(port, connectLine("unlisted.example.test:443"));
    expect(await readAll(socket)).toMatch(/^HTTP\/1\.1 403/);
    expect(tainted).toEqual([]);
  });
});
