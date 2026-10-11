import { ALL_PERMISSIONS, type Caller, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createFakeClock, type FakeClock } from "../clock.ts";
import { startServer, type RunningServer } from "../http/server.ts";
import { silentLogger, type Logger } from "../logger.ts";
import { createDispatcher } from "./dispatcher.ts";
import { createStreamHub, type StreamHub } from "./stream-hub.ts";
import { systemHandlers } from "./system-handlers.ts";
import {
  CLOSE_GRACE_MS,
  CLOSE_UNAUTHENTICATED,
  createWsServer,
  KEEPALIVE_MS,
  type WsServer,
} from "./ws-server.ts";

const ORIGIN = "http://localhost:7777";
// More than the credential: nothing but the credential may be kept or asked about.
const COOKIE = "pap_session=good; theme=dark";
const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };

let server: RunningServer;
let ws: WsServer;
let hub: StreamHub;
let clock: FakeClock;
let errors: string[];
// What the session store would answer: flipped by a test to stand for a sign-out, an expiry or a database error.
let session: "valid" | "gone" | "broken";
// Every question put to the session store: with what, and whether the answer may extend the session.
let asked: Array<{ credential: string | undefined; slide: boolean }>;

beforeEach(async () => {
  clock = createFakeClock(1);
  errors = [];
  asked = [];
  session = "valid";
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg) => errors.push(msg),
    child: () => logger,
  };
  hub = createStreamHub("epoch-1", clock);
  hub.registerSnapshot("session", (key) => ({ kind: "snapshot", key }));
  const handlers = {
    ...systemHandlers(clock),
    "subscribe.session": async ({ sessionId }: { sessionId: string }, ctx: HandlerContext) => ({
      sub: ctx.openSubscription("session", sessionId, undefined),
    }),
  } as unknown as HandlerTable;
  ws = createWsServer({
    allowedOrigins: new Set([ORIGIN]),
    credentialOf: (header) => /pap_session=([^;]+)/.exec(header ?? "")?.[1],
    authenticate: (credential, options) => {
      asked.push({ credential, slide: options?.slide ?? true });
      if (session === "broken") throw new Error("database is locked");
      return credential === "good" && session === "valid" ? owner : null;
    },
    dispatch: createDispatcher({
      handlers,
      receipts: { find: () => null, save: () => {}, purge: () => 0, readOnly: false },
      logger: silentLogger,
    }),
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
  call(frame: object): Promise<unknown>;
}

async function connect(): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?proto=1`, {
    headers: { origin: ORIGIN, cookie: COOKIE },
  });
  const answers = new Map<number, (frame: unknown) => void>();
  let greeted: () => void = () => {};
  const hello = new Promise<void>((resolve) => (greeted = resolve));
  const closed = new Promise<number>((done) => socket.on("close", (code) => done(code)));
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as { id?: number; protocol?: number };
    if (frame.protocol !== undefined) greeted();
    else if (frame.id !== undefined) answers.get(frame.id)?.(frame);
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  await hello;
  return {
    socket,
    closed,
    call: (frame) =>
      new Promise((resolve) => {
        answers.set((frame as { id: number }).id, resolve);
        socket.send(JSON.stringify(frame));
      }),
  };
}

async function subscribed(): Promise<Client> {
  const client = await connect();
  await client.call({ id: 1, method: "subscribe.session", params: { sessionId: "k" } });
  await client.call({ id: 2, method: "system.ping", params: {} });
  expect(hub.stats().subscriptions).toBe(1);
  return client;
}

describe("/ws session revocation", () => {
  it("answers unauthenticated and closes with 4401 on the first request after the session ended", async () => {
    const client = await subscribed();
    session = "gone";
    expect(await client.call({ id: 31, method: "system.ping", params: {} })).toEqual({
      id: 31,
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(await client.closed).toBe(CLOSE_UNAUTHENTICATED);
    expect(hub.stats().subscriptions).toBe(0);
  });

  it("serves nothing to a revoked socket, whatever the frame", async () => {
    const client = await connect();
    session = "gone";
    client.socket.send("not json");
    expect(await client.closed).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("closes an idle socket at the next keepalive tick and stops its live events at once", async () => {
    const client = await subscribed();
    await clock.advance(KEEPALIVE_MS);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    session = "gone";
    await clock.advance(KEEPALIVE_MS);
    expect(await client.closed).toBe(CLOSE_UNAUTHENTICATED);
    expect(hub.stats().subscriptions).toBe(0);
    await vi.waitFor(() => expect(clock.pending()).toBe(0));
  });

  it("cuts a revoked peer that never answers the close frame", { timeout: 5000 }, async () => {
    const client = await subscribed();
    session = "gone";
    client.socket.pause();
    client.socket.send(JSON.stringify({ id: 33, method: "system.ping", params: {} }));
    await vi.waitFor(() => expect(hub.stats().subscriptions).toBe(0));
    const closing = server.close();
    await clock.advance(CLOSE_GRACE_MS);
    await closing;
    client.socket.terminate();
  });

  it("keeps the socket when the check itself fails and refuses the request meanwhile", async () => {
    const client = await subscribed();
    session = "broken";
    expect(await client.call({ id: 34, method: "system.ping", params: {} })).toEqual({
      id: 34,
      ok: false,
      error: { code: "internal" },
    });
    await clock.advance(KEEPALIVE_MS);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(errors).toContain("ws_authenticate_failed");
    session = "valid";
    expect(await client.call({ id: 35, method: "system.ping", params: {} })).toMatchObject({ ok: true });
    client.socket.close();
  });

  it("asks with the session value alone, and slides on request frames but never on a tick (R130)", async () => {
    const client = await subscribed();
    await clock.advance(KEEPALIVE_MS);
    await client.call({ id: 40, method: "system.ping", params: {} });
    await clock.advance(KEEPALIVE_MS);
    expect(asked.every(({ credential }) => credential === "good")).toBe(true);
    expect(JSON.stringify(asked)).not.toContain("theme");
    const ticks = asked.filter(({ slide }) => !slide);
    expect(ticks).toHaveLength(2);
    // The upgrade and each request frame (subscribe, ping, ping) are ordinary requests.
    expect(asked.filter(({ slide }) => slide)).toHaveLength(4);
    client.socket.close();
  });
});
