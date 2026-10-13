import {
  PapError,
  PROTOCOL_VERSION,
  type Caller,
  type Cursor,
  type HandlerContext,
  type HandlerTable,
} from "@pap/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import { createFakeClock, type FakeClock } from "../clock.ts";
import { startServer, type RunningServer } from "../http/server.ts";
import { silentLogger, type Logger } from "../logger.ts";
import { createDispatcher, type Dispatch } from "./dispatcher.ts";
import { createStreamHub, type StreamHub } from "./stream-hub.ts";
import { systemHandlers } from "./system-handlers.ts";
import {
  CLOSE_GRACE_MS,
  createWsServer,
  KEEPALIVE_MS,
  MAX_SUBSCRIPTIONS,
  type WsServer,
} from "./ws-server.ts";
import { testCaller } from "../../testing/caller.ts";

const ORIGIN = "http://localhost:7777";
const EXPLODING_ID = 666;
const owner: Caller = testCaller();
const good = { origin: ORIGIN, cookie: "pap_session=good" };

let server: RunningServer;
let ws: WsServer;
let hub: StreamHub;
let clock: FakeClock;
let logs: Array<{ level: string; msg: string }>;

beforeEach(async () => {
  clock = createFakeClock(1);
  logs = [];
  const logger: Logger = {
    debug: (msg) => logs.push({ level: "debug", msg }),
    info: (msg) => logs.push({ level: "info", msg }),
    warn: (msg) => logs.push({ level: "warn", msg }),
    error: (msg) => logs.push({ level: "error", msg }),
    child: () => logger,
  };
  hub = createStreamHub("epoch-1", clock);
  hub.registerSnapshot("session", (key) => {
    if (key === "missing") throw new PapError("not_found");
    if (key === "broken") throw new Error("unreadable transcript");
    return { kind: "snapshot", key };
  });
  const handlers = {
    ...systemHandlers(clock),
    // Opens a subscription, then fails: the prepared subscription must not outlive the error response.
    "sessions.list": async (_params: unknown, ctx: HandlerContext) => {
      ctx.openSubscription("session", "k", undefined);
      throw new PapError("not_found");
    },
    "subscribe.session": async (
      { sessionId, after }: { sessionId: string; after?: Cursor },
      ctx: HandlerContext,
    ) => ({ sub: ctx.openSubscription("session", sessionId, after) }),
  } as unknown as HandlerTable;
  const inner = createDispatcher({
    handlers,
    receipts: { find: () => null, save: () => {}, purge: () => 0, readOnly: false },
    logger: silentLogger,
  });
  // A dispatcher that itself rejects: the socket layer must still answer and survive (R6).
  const dispatch: Dispatch = (frame, ctx) =>
    frame.id === EXPLODING_ID ? Promise.reject(new Error("dispatch exploded")) : inner(frame, ctx);
  ws = createWsServer({
    allowedOrigins: new Set([ORIGIN]),
    credentialOf: ({ cookie }) => (cookie ? { kind: "cookie", value: cookie } : undefined),
    authenticate: (credential) => (credential?.value === "pap_session=good" ? owner : null),
    dispatch,
    hub,
    logger,
    clock,
    serverVersion: "0.0.0-test",
  });
  server = await startServer({
    app: new Hono(),
    host: "127.0.0.1",
    port: 0,
    tls: null,
    onUpgrade: (req, socket, head) => ws.handleUpgrade(req, socket, head),
    onError: () => {},
  });
});
afterEach(async () => {
  ws.close();
  await clock.advance(CLOSE_GRACE_MS);
  await server.close();
});

interface Client {
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  next(): Promise<unknown>;
  call(frame: object): Promise<unknown>;
}

function connect(
  headers: Record<string, string>,
  path = `/ws?proto=${PROTOCOL_VERSION}`,
  options: ClientOptions = {},
) {
  return new Promise<Client>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { ...options, headers });
    const queue: unknown[] = [];
    const waiting: Array<(frame: unknown) => void> = [];
    const closed = new Promise<number>((done) => socket.on("close", (code) => done(code)));
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data)) as unknown;
      const waiter = waiting.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    });
    socket.on("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    socket.on("error", reject);
    socket.on("open", () => {
      const next = (): Promise<unknown> =>
        queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r));
      resolve({
        socket,
        closed,
        next,
        call: (frame) => {
          socket.send(JSON.stringify(frame));
          return next();
        },
      });
    });
  });
}

async function greeted(options: ClientOptions = {}): Promise<Client> {
  const client = await connect(good, `/ws?proto=${PROTOCOL_VERSION}`, options);
  await client.next();
  return client;
}

describe("/ws upgrade gate", () => {
  it("rejects a forged Origin, an old protocol and a missing session", async () => {
    await expect(connect({ ...good, origin: "http://evil.example" })).rejects.toThrow("status 403");
    await expect(connect(good, "/ws?proto=0")).rejects.toThrow("status 426");
    await expect(connect({ origin: ORIGIN })).rejects.toThrow("status 401");
  });

  it("rejects any other path and a request without an Origin", async () => {
    await expect(connect(good, `/other?proto=${PROTOCOL_VERSION}`)).rejects.toThrow("status 404");
    await expect(connect({ cookie: good.cookie })).rejects.toThrow("status 403");
  });

  it("refuses new upgrades once the server is closing", async () => {
    ws.close();
    await expect(connect(good)).rejects.toThrow("status 503");
  });
});

describe("/ws requests", () => {
  it("greets with hello, then answers requests", async () => {
    const client = await connect(good);
    expect(await client.next()).toEqual({
      protocol: PROTOCOL_VERSION,
      capabilities: ["rpc", "subscribe"],
      serverVersion: "0.0.0-test",
    });
    expect(await client.call({ id: 1, method: "system.ping", params: {} })).toEqual({
      id: 1,
      ok: true,
      result: { now: 1 },
    });
    client.socket.close();
  });

  it("keeps the socket open after bad JSON and invalid params", async () => {
    const client = await greeted();
    client.socket.send("not json");
    expect(await client.call({ id: 2, method: "subscribe.session", params: {} })).toEqual({
      id: 2,
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await client.call({ id: 3, method: "system.ping", params: {} })).toEqual({
      id: 3,
      ok: true,
      result: { now: 1 },
    });
    client.socket.close();
  });

  it("answers internal and keeps the socket open when the dispatcher itself rejects (R6)", async () => {
    const client = await greeted();
    expect(await client.call({ id: EXPLODING_ID, method: "system.ping", params: {} })).toEqual({
      id: EXPLODING_ID,
      ok: false,
      error: { code: "internal" },
    });
    expect(await client.call({ id: 4, method: "system.ping", params: {} })).toEqual({
      id: 4,
      ok: true,
      result: { now: 1 },
    });
    expect(logs.filter((entry) => entry.msg === "ws_message_failed")).toHaveLength(1);
    client.socket.close();
  });

  it("closes with 1009 on a frame above 1 MiB", async () => {
    const client = await greeted();
    client.socket.send(
      JSON.stringify({ id: 4, method: "system.ping", params: { pad: "x".repeat(1024 * 1024) } }),
    );
    expect(await client.closed).toBe(1009);
  });
});

describe("/ws subscriptions", () => {
  it("sends the subscribe response before the snapshot, then live events", async () => {
    const client = await greeted();
    expect(await client.call({ id: 5, method: "subscribe.session", params: { sessionId: "k" } })).toEqual({
      id: 5,
      ok: true,
      result: { sub: "s1" },
    });
    expect(await client.next()).toEqual({
      sub: "s1",
      epoch: "epoch-1",
      seq: 0,
      event: { kind: "snapshot", key: "k" },
    });
    hub.publish("session", "k", { n: 1 });
    expect(await client.next()).toEqual({ sub: "s1", epoch: "epoch-1", seq: 1, event: { n: 1 } });
    client.socket.close();
  });

  it("resumes from a cursor of this epoch with only the missed events", async () => {
    for (const n of [1, 2, 3]) hub.publish("session", "k", { n });
    const client = await greeted();
    const params = { sessionId: "k", after: { epoch: "epoch-1", seq: 1 } };
    expect(await client.call({ id: 6, method: "subscribe.session", params })).toEqual({
      id: 6,
      ok: true,
      result: { sub: "s1" },
    });
    expect(await client.next()).toEqual({ sub: "s1", epoch: "epoch-1", seq: 2, event: { n: 2 } });
    expect(await client.next()).toEqual({ sub: "s1", epoch: "epoch-1", seq: 3, event: { n: 3 } });
    client.socket.close();
  });

  it("stops events after unsubscribe", async () => {
    const client = await greeted();
    await client.call({ id: 7, method: "subscribe.session", params: { sessionId: "k" } });
    await client.next();
    expect(await client.call({ id: 8, method: "unsubscribe", params: { sub: "s1" } })).toEqual({
      id: 8,
      ok: true,
      result: { ok: true },
    });
    hub.publish("session", "k", { n: 1 });
    expect(await client.call({ id: 9, method: "system.ping", params: {} })).toEqual({
      id: 9,
      ok: true,
      result: { now: 1 },
    });
    client.socket.close();
  });

  it("answers the error and registers nothing when the snapshot cannot be built", async () => {
    const client = await greeted();
    const subscribe = (id: number, sessionId: string) =>
      client.call({ id, method: "subscribe.session", params: { sessionId } });
    expect(await subscribe(11, "missing")).toEqual({ id: 11, ok: false, error: { code: "not_found" } });
    expect(await subscribe(12, "broken")).toEqual({ id: 12, ok: false, error: { code: "internal" } });
    for (let n = 0; n < MAX_SUBSCRIPTIONS; n++) await subscribe(100 + n, "missing");
    hub.publish("session", "missing", { n: 1 });
    hub.publish("session", "broken", { n: 1 });
    expect(await client.call({ id: 13, method: "system.ping", params: {} })).toEqual({
      id: 13,
      ok: true,
      result: { now: 1 },
    });
    expect(hub.stats().subscriptions).toBe(0);
    expect(await subscribe(14, "k")).toEqual({ id: 14, ok: true, result: { sub: "s1" } });
    client.socket.close();
  });

  it("drops a subscription opened by a handler that then fails", async () => {
    const client = await greeted();
    expect(await client.call({ id: 15, method: "sessions.list", params: {} })).toEqual({
      id: 15,
      ok: false,
      error: { code: "not_found" },
    });
    expect(hub.stats().subscriptions).toBe(0);
    hub.publish("session", "k", { n: 1 });
    expect(await client.call({ id: 16, method: "system.ping", params: {} })).toEqual({
      id: 16,
      ok: true,
      result: { now: 1 },
    });
    client.socket.close();
  });

  it("allows 64 subscriptions per connection, then answers capacity until one is closed", async () => {
    const client = await greeted();
    for (let n = 1; n <= MAX_SUBSCRIPTIONS; n++) {
      const params = { sessionId: `k${n}` };
      expect(await client.call({ id: n, method: "subscribe.session", params })).toEqual({
        id: n,
        ok: true,
        result: { sub: `s${n}` },
      });
      await client.next();
    }
    const extra = { method: "subscribe.session", params: { sessionId: "extra" } };
    expect(await client.call({ id: 200, ...extra })).toEqual({
      id: 200,
      ok: false,
      error: { code: "capacity" },
    });
    expect(hub.stats().subscriptions).toBe(MAX_SUBSCRIPTIONS);
    await client.call({ id: 201, method: "unsubscribe", params: { sub: "s1" } });
    expect(await client.call({ id: 202, ...extra })).toEqual({
      id: 202,
      ok: true,
      result: { sub: `s${MAX_SUBSCRIPTIONS + 1}` },
    });
    await client.next();
    client.socket.close();
  });

  it("terminates a consumer that stops reading and logs it once", async () => {
    const client = await greeted();
    await client.call({ id: 10, method: "subscribe.session", params: { sessionId: "k" } });
    await client.next();
    client.socket.pause();
    const blob = "x".repeat(900_000);
    for (let n = 0; n < 60; n++) hub.publish("session", "k", { blob });
    expect(logs.filter((entry) => entry.msg === "ws_slow_consumer")).toHaveLength(1);
    client.socket.terminate();
  });
});

describe("/ws keepalive (R7)", () => {
  it("terminates a peer that stays silent for 15 s, not before", async () => {
    const client = await greeted({ autoPong: false });
    await clock.advance(KEEPALIVE_MS - 1);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    await clock.advance(1);
    expect(await client.closed).toBe(1006);
  });

  it("keeps a peer that talks in every window", async () => {
    const client = await greeted({ autoPong: false });
    for (let window = 0; window < 4; window++) {
      await client.call({ id: 20 + window, method: "system.ping", params: {} });
      await clock.advance(KEEPALIVE_MS);
    }
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    client.socket.close();
  });
});

describe("/ws shutdown (R76)", () => {
  it("closes an open client with 1001 before the server's close resolves", async () => {
    const client = await greeted();
    ws.close();
    expect(await client.closed).toBe(1001);
    await server.close();
  });

  it("does not hang on a peer that never answers the close", { timeout: 5000 }, async () => {
    const client = await greeted();
    client.socket.pause();
    ws.close();
    const closing = server.close();
    await clock.advance(CLOSE_GRACE_MS);
    await closing;
    client.socket.terminate();
  });
});
