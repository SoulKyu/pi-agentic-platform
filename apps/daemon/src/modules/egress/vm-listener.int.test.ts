import { createServer as createHttp } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { loopbackVmSeams } from "./testing/vm.ts";
import { createVmEgress, type VmRefusal, type VmScope } from "./vm-listener.ts";

/*
 * Mutation checks (AVM2-E8), each reverted for real in the source and seen to fail (the address-policy ones are in vm-judge.test.ts):
 *  - M6i  DNS pinning: the judge answers `ips: [host]` instead of the checked answers -> "tunnels bytes both ways ... checked address"
 *  - M7   unknown source: `scope === null` dropped from the connection guard -> "answers 403 without onRefusal to an address with no running launch"
 *  - M8   a stale host list: `judge.decide(scope, ...)` instead of the list read again -> "reads the host list again at each request"
 */
const VM_A = "127.0.0.9";
const VM_B = "127.0.0.10";
const STRANGER = "127.0.0.11";

const listening = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );

/** Dials the proxy from a given source address (any 127.0.0.0/8 address is local) and sends `payload`. */
function dial(port: number, from: string, payload: string): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, localAddress: from });
    socket.on("error", () => {});
    socket.once("connect", () => {
      socket.write(payload);
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
const readHead = (socket: Socket): Promise<string> =>
  new Promise((resolve) => {
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString();
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve(head);
    };
    socket.on("data", onData);
  });
const nextData = (socket: Socket): Promise<string> =>
  new Promise((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
const connectLine = (target: string): string => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

describe("the VM egress listener", () => {
  let echo: Server;
  let origin: ReturnType<typeof createHttp>;
  let echoConnections = 0;
  let seenPaths: string[] = [];
  let sockets: Set<Socket>;
  let clock: FakeClock;
  let lines: Array<Record<string, unknown>>;
  let refusals: VmRefusal[];
  let scopes: Map<string, VmScope>;
  let seams: ReturnType<typeof loopbackVmSeams>;
  let port: number;
  let egress: ReturnType<typeof createVmEgress>;

  const scope = (agentId: string, launchId: string, hosts: string[]): VmScope => ({
    agentId,
    launchId,
    source: "thread",
    hosts,
    trustedSources: [],
  });

  beforeEach(async () => {
    sockets = new Set();
    echoConnections = 0;
    seenPaths = [];
    echo = createServer((socket) => {
      echoConnections += 1;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      socket.pipe(socket);
    });
    origin = createHttp((req, res) => {
      seenPaths.push(req.url ?? "");
      res.end("origin ok");
    });
    const echoPort = await listening(echo);
    const originPort = await listening(origin);
    seams = loopbackVmSeams({
      "api.example.test": { 80: originPort, 443: echoPort },
      "other.example.test": { 80: originPort, 443: echoPort },
    });
    clock = createFakeClock();
    const captured = captureLogger();
    lines = captured.lines;
    refusals = [];
    scopes = new Map([
      [VM_A, scope("atlas-1a2b", "launch-a", ["api.example.test"])],
      [VM_B, scope("bravo-3c4d", "launch-b", ["other.example.test"])],
    ]);
    egress = createVmEgress({
      clock,
      logger: captured.logger,
      ...seams,
      scopeOf: (address) => scopes.get(address) ?? null,
      onRefusal: (refusal) => void refusals.push(refusal),
    });
    port = await egress.listen("127.0.0.1", 0);
  });

  afterEach(async () => {
    await egress.close();
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections();
    await Promise.all([new Promise((r) => echo.close(r)), new Promise((r) => origin.close(r))]);
  });

  it("tunnels bytes both ways for a listed host and connects only to the checked address", async () => {
    const socket = await dial(port, VM_A, connectLine("api.example.test:443"));
    expect(await readHead(socket)).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    socket.write("ping");
    expect(await nextData(socket)).toBe("ping");
    // DNS pinning: one lookup, and the connector got the address that was checked, never the name.
    expect(seams.calls.resolve).toEqual(["api.example.test"]);
    expect(seams.calls.connect).toEqual([{ ip: "127.7.0.1", port: 443 }]);
    socket.destroy();
  });

  it("answers 403 with the host, the port and the reason, tells onRefusal once, and reaches nothing", async () => {
    const socket = await dial(port, VM_A, connectLine("other.example.test:443"));
    const reply = await readAll(socket);
    expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(reply).toMatch(/other\.example\.test:443/);
    expect(reply).toMatch(/not_listed/);
    expect(refusals).toEqual([
      {
        agentId: "atlas-1a2b",
        launchId: "launch-a",
        source: "thread",
        host: "other.example.test",
        port: 443,
        reason: "not_listed",
        address: null,
      },
    ]);
    expect(echoConnections).toBe(0);
    expect(seams.calls.connect).toEqual([]);
  });

  it("refuses a port the entry does not list, even for a listed host", async () => {
    const socket = await dial(port, VM_A, connectLine("api.example.test:8080"));
    expect(await readAll(socket)).toMatch(/403 Forbidden[\s\S]*api\.example\.test:8080[\s\S]*not_listed/);
    expect(seams.calls.connect).toEqual([]);
  });

  it("answers 403 without onRefusal to an address with no running launch", async () => {
    const socket = await dial(port, STRANGER, connectLine("api.example.test:443"));
    const reply = await readAll(socket);
    expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    // M4: a one-line reason the client prints.
    expect(reply).toContain("x-pap-deny: unknown_source");
    expect(reply.split("\r\n\r\n")[1]).toBe(
      "pap egress proxy: this address is not a running agent VM, nothing was sent.\n",
    );
    expect(refusals).toEqual([]);
    expect(seams.calls.resolve).toEqual([]);
    expect(echoConnections).toBe(0);
  });

  it("judges each VM by its own list", async () => {
    const a = await dial(port, VM_A, connectLine("other.example.test:443"));
    expect(await readAll(a)).toMatch(/403/);
    const b = await dial(port, VM_B, connectLine("other.example.test:443"));
    expect(await readHead(b)).toMatch(/200 Connection Established/);
    b.destroy();
  });

  it("reads the host list again at each request: an add takes effect at the next one", async () => {
    expect(await readAll(await dial(port, VM_A, connectLine("other.example.test:443")))).toMatch(/403/);
    scopes.set(VM_A, scope("atlas-1a2b", "launch-a", ["api.example.test", "other.example.test"]));
    const socket = await dial(port, VM_A, connectLine("other.example.test:443"));
    expect(await readHead(socket)).toMatch(/200 Connection Established/);
    socket.destroy();
  });

  it("forwards a plain HTTP GET to a listed host and refuses an unlisted one", async () => {
    const ok = await dial(
      port,
      VM_A,
      "GET http://api.example.test/hello HTTP/1.1\r\nHost: api.example.test\r\n\r\n",
    );
    const reply = await readAll(ok);
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply).toMatch(/origin ok/);
    expect(seenPaths).toEqual(["/hello"]);
    const no = await dial(
      port,
      VM_A,
      "GET http://other.example.test/x HTTP/1.1\r\nHost: other.example.test\r\n\r\n",
    );
    const refused = await readAll(no);
    expect(refused).toMatch(/^HTTP\/1\.1 403/);
    expect(refused).toMatch(/other\.example\.test:80 .*not_listed/);
    expect(seenPaths).toEqual(["/hello"]);
    expect(refusals.map((r) => [r.host, r.port, r.reason])).toEqual([
      ["other.example.test", 80, "not_listed"],
    ]);
  });

  it("logs each agent's usage every 60 s, hosts labelled by the W5-R54 rule", async () => {
    const tunnelA = await dial(port, VM_A, connectLine("api.example.test:443"));
    await readHead(tunnelA);
    tunnelA.write("hello!");
    await nextData(tunnelA);
    await readAll(await dial(port, VM_A, connectLine("other.example.test:443")));
    await readAll(await dial(port, VM_B, connectLine("api.example.test:443")));
    await clock.advance(60_000);
    const usage = lines.filter((line) => line.msg === "egress_vm_usage");
    const a = usage.find((line) => line.agentId === "atlas-1a2b");
    expect(a).toMatchObject({ launchId: "launch-a", requests: 2, refused: 1, up: 6, down: 6 });
    const hosts = a?.hosts as string[];
    expect(hosts).toContain("api.example.test");
    expect(hosts.some((host) => host.startsWith("h:") && host.endsWith("(len 18)"))).toBe(true);
    expect(hosts).not.toContain("other.example.test");
    expect(usage.find((line) => line.agentId === "bravo-3c4d")).toMatchObject({ requests: 1, refused: 1 });
    // The next window starts from zero.
    await clock.advance(60_000);
    expect(
      lines.filter((line) => line.msg === "egress_vm_usage" && line.agentId === "atlas-1a2b"),
    ).toHaveLength(1);
    tunnelA.destroy();
  });

  it("ends the tunnels of a launch that is gone at the next minute", async () => {
    const socket = await dial(port, VM_A, connectLine("api.example.test:443"));
    await readHead(socket);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    scopes.delete(VM_A);
    await clock.advance(60_000);
    await closed;
    expect((await readAll(await dial(port, VM_A, connectLine("api.example.test:443")))).slice(0, 12)).toBe(
      "HTTP/1.1 403",
    );
  });

  it("answers 403 and logs when the scope lookup throws, and keeps serving", async () => {
    const flaky = new Map(scopes);
    let broken = true;
    const other = createVmEgress({
      clock,
      logger: captureLogger().logger,
      ...seams,
      scopeOf: (address) => {
        if (broken) throw new Error("database is locked");
        return flaky.get(address) ?? null;
      },
      onRefusal: () => {},
    });
    const otherPort = await other.listen("127.0.0.1", 0);
    expect(
      (await readAll(await dial(otherPort, VM_A, connectLine("api.example.test:443")))).slice(0, 12),
    ).toBe("HTTP/1.1 403");
    broken = false;
    const socket = await dial(otherPort, VM_A, connectLine("api.example.test:443"));
    expect(await readHead(socket)).toMatch(/200 Connection Established/);
    socket.destroy();
    await other.close();
  });

  it("answers 502 with the reason resolve for a listed name that does not resolve", async () => {
    scopes.set(VM_A, scope("atlas-1a2b", "launch-a", ["gone.example.test"]));
    const reply = await readAll(await dial(port, VM_A, connectLine("gone.example.test:443")));
    expect(reply).toMatch(/^HTTP\/1\.1 502 Bad Gateway/);
    expect(reply).toMatch(/gone\.example\.test:443 could not be resolved \(resolve\)/);
    expect(refusals).toEqual([]);
  });

  it("a launch that vanished mid-connection gets a 403 that does not suggest network_request", async () => {
    const socket = await dial(port, VM_A, "");
    scopes.delete(VM_A);
    socket.write(connectLine("api.example.test:443"));
    const reply = await readAll(socket);
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    expect(reply).toMatch(/no running launch/);
    expect(reply).not.toMatch(/network_request/);
  });
});
