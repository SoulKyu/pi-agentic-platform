import { createServer } from "node:http";
import { connect, createServer as createTcp, type Server, type Socket } from "node:net";
import { EGRESS_LIMITS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createLookup } from "./lookup.ts";
import { createCores, type Limits } from "./proxy-core.ts";
import { loopbackBed } from "./testing/loopback.ts";

/** The shared core's counted limits and the lookup semaphore, driven through the core directly on loopback (ported from the host proxy tests). */
const open: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of open.splice(0)) await new Promise((resolve) => server.close(resolve));
});

const listening = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    open.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
const connectLine = (target: string): string => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
const statusOf = (reply: string): string => reply.split("\r\n", 1)[0] ?? "";
const denyOf = (reply: string): string | undefined => /^x-pap-deny: (.*)\r$/im.exec(reply)?.[1];

/** Two proxy servers (two cores) sharing one `createCores`, in front of one echo server. */
async function bed(over: Partial<Limits>) {
  const echo = createTcp((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  const echoPort = await listening(echo);
  const loop = loopbackBed({ "api.example.test": { 443: echoPort } });
  const clock = createFakeClock();
  const cores = createCores({
    clock,
    logger: captureLogger().logger,
    connect: loop.connect,
    limits: { ...EGRESS_LIMITS, ...over },
  });
  const serve = async (): Promise<number> => {
    const core = cores.create({
      scope: { agentId: "atlas-1a2b", sessionId: "s1" },
      decide: async () => ({ ips: ["127.7.0.1"], host: "api.example.test" }),
    });
    const server = createServer();
    core.attach(server);
    return listening(server);
  };
  return { serve };
}

function exchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect(port, "127.0.0.1");
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    socket.write(payload);
  });
}
function tunnel(port: number): Promise<{ socket: Socket; head: string }> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    sockets.add(socket);
    socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString();
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ socket, head });
    };
    socket.on("data", onData);
    socket.write(connectLine("api.example.test:443"));
  });
}

describe("the core's counted limits", () => {
  it("a connection past the cap is refused with limit, and a freed slot is reusable", async () => {
    const port = await (await bed({ connections: 2 })).serve();
    const a = await tunnel(port);
    const b = await tunnel(port);
    const third = await exchange(port, connectLine("api.example.test:443"));
    expect(statusOf(third)).toBe("HTTP/1.1 503 Service Unavailable");
    expect(denyOf(third)).toBe("limit");
    a.socket.destroy();
    await vi.waitFor(
      async () => {
        const again = await tunnel(port);
        again.socket.destroy();
        expect(statusOf(again.head)).toBe("HTTP/1.1 200 Connection Established");
      },
      { timeout: 5000 },
    );
    b.socket.destroy();
  });

  it("refuses an upstream connection past the daemon-wide cap, across cores", async () => {
    const { serve } = await bed({ upstream: 1 });
    const [first, second] = [await serve(), await serve()];
    const held = await tunnel(first);
    const refused = await exchange(second, connectLine("api.example.test:443"));
    expect(statusOf(refused)).toBe("HTTP/1.1 503 Service Unavailable");
    expect(denyOf(refused)).toBe("limit");
    held.socket.destroy();
  });
});

describe("the lookup semaphore and its deadline", () => {
  /** A resolver that answers only when the test says so. */
  function setup() {
    const clock = createFakeClock();
    const pending: Array<(answers: string[]) => void> = [];
    const started: string[] = [];
    const { lookup, busyKeys } = createLookup({
      clock,
      logger: captureLogger().logger,
      resolveMs: EGRESS_LIMITS.resolveMs,
      resolve: (host) => {
        started.push(host);
        return new Promise<readonly string[]>((resolve) => pending.push(resolve));
      },
    });
    return { clock, pending, started, lookup, busyKeys };
  }
  const key = (lane: object, session: string): readonly [object, string] => [lane, session];

  it("at most 2 lookups run daemon-wide: a third waits for a slot", async () => {
    const { pending, started, lookup } = setup();
    const done = ["a", "b", "c"].map((s) => lookup(key({}, s), "h.test"));
    await vi.waitFor(() => expect(started).toHaveLength(2));
    pending[0]?.(["1.1.1.1"]);
    await vi.waitFor(() => expect(started).toHaveLength(3));
    pending[1]?.([]);
    pending[2]?.([]);
    await Promise.all(done);
  });

  it("one lane runs one lookup at a time, and another lane is not held up", async () => {
    const { pending, started, lookup, busyKeys } = setup();
    const lane = {};
    const first = lookup(key(lane, "s1"), "a.test");
    const second = lookup(key(lane, "s1"), "b.test");
    const apart = lookup(key({}, "s2"), "c.test");
    await vi.waitFor(() => expect(started).toEqual(["a.test", "c.test"]));
    pending[0]?.([]);
    await vi.waitFor(() => expect(started).toEqual(["a.test", "c.test", "b.test"]));
    pending[1]?.([]);
    pending[2]?.([]);
    await Promise.all([first, second, apart]);
    expect(busyKeys()).toBe(0);
  });

  it("a queued lookup past the 5 s deadline fails and never starts", async () => {
    const { clock, pending, started, lookup } = setup();
    const first = [lookup(key({}, "a"), "h.test"), lookup(key({}, "b"), "h.test")];
    const settled = first.map((each) =>
      each.then(
        () => "ok",
        (error: Error) => error.message,
      ),
    );
    await vi.waitFor(() => expect(started).toHaveLength(2));
    const queued = lookup(key({}, "c"), "h.test");
    const rejected = expect(queued).rejects.toThrow("resolve timeout");
    await clock.advance(EGRESS_LIMITS.resolveMs + 1);
    await rejected;
    expect(started).toHaveLength(2);
    expect(await Promise.all(settled)).toEqual(["resolve timeout", "resolve timeout"]);
    pending[0]?.([]);
    pending[1]?.([]);
    await clock.advance(0);
    expect(started).toHaveLength(2);
  });
});
