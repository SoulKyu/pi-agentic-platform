import {
  encodeFrame,
  FRAME_OPS,
  PROTOCOL_VERSION,
  type Caller,
  type HandlerContext,
  type RequestFrame,
  type ResponseFrame,
} from "@pap/contracts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { connectTestClient, type TestClient } from "../../testing/ws-client.ts";
import { createSystemClock } from "../clock.ts";
import { startServer, type RunningServer } from "../http/server.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import type { Logger } from "../logger.ts";
import { createStreamHub } from "./stream-hub.ts";
import { CLOSE_UNAUTHENTICATED, createWsServer, type WsServer } from "./ws-server.ts";

const ORIGIN = "http://localhost:7777";
const owner: Caller = testCaller();

let server: RunningServer;
let ws: WsServer;
let session: "valid" | "gone";
let failNextCheck: boolean;
let logLines: Array<Record<string, unknown>>;
let events: string[];
let inputs: string[];
let clients: TestClient[];

/**
 * The test client only knows real methods, so every call is `system.ping` and `params.mode` picks the behaviour:
 * `open` opens one stream and sends one output frame from onOpen; `openThenThrow` fails after opening it;
 * `openThenFail` opens one and answers `not_found` (the way the real dispatcher maps a typed error).
 */
async function dispatch(frame: RequestFrame, ctx: HandlerContext): Promise<ResponseFrame> {
  const mode = (frame.params as { mode?: string } | undefined)?.mode;
  if (mode === undefined) return { id: frame.id, ok: true, result: { ok: true } } as ResponseFrame;
  const binary = ctx.binary;
  if (!binary) throw new Error("no binary channel");
  // The arrays of this test: a late callback must not land in the next test's.
  const log = events;
  const received = inputs;
  const stream = binary.open({
    onOpen: () => {
      log.push("open");
      stream.send("output", 0, Uint8Array.of(0x68, 0x69));
    },
    onInput: (seq, payload) => void received.push(`${seq}:${new TextDecoder().decode(payload)}`),
    onAck: () => {},
    onClose: () => void log.push("close"),
  });
  if (mode === "openThenThrow") throw new Error("handler failed");
  if (mode === "openThenFail") return { id: frame.id, ok: false, error: { code: "not_found" } };
  return { id: frame.id, ok: true, result: { streamId: stream.streamId } } as ResponseFrame;
}

beforeEach(async () => {
  session = "valid";
  failNextCheck = false;
  events = [];
  inputs = [];
  clients = [];
  const clock = createSystemClock();
  const captured = captureLogger();
  logLines = captured.lines;
  const logger: Logger = captured.logger;
  const realHub = createStreamHub("epoch-binary", clock);
  const log = events;
  // The hub's close is the first thing `revoke()` and the socket's `close` do: it marks where each one ran.
  const hub = {
    ...realHub,
    close: (...args: Parameters<typeof realHub.close>) => {
      log.push("hub.close");
      realHub.close(...args);
    },
  };
  ws = createWsServer({
    allowedOrigins: new Set([ORIGIN]),
    credentialOf: ({ cookie }) => (cookie ? { kind: "cookie", value: cookie } : undefined),
    authenticate: () => {
      if (failNextCheck) {
        failNextCheck = false;
        throw new Error("database is locked");
      }
      return session === "valid" ? owner : null;
    },
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
  for (const client of clients) client.close();
  ws.close();
  await server.close();
});

async function connect(): Promise<TestClient> {
  const client = await connectTestClient(`ws://127.0.0.1:${server.port}/ws?proto=${PROTOCOL_VERSION}`, {
    origin: ORIGIN,
    cookie: "pap_session=good",
  });
  clients.push(client);
  return client;
}

const call = (client: TestClient, mode?: "open" | "openThenThrow" | "openThenFail") =>
  client.call("system.ping", (mode ? { mode } : {}) as never, 5_000);

describe("binary frames on /ws", () => {
  it("sends the JSON answer before the first binary frame", async () => {
    const client = await connect();
    const answer = await call(client, "open");
    expect(answer).toMatchObject({ ok: true, result: { streamId: 1 } });
    const frame = await client.waitForBinary((candidate) => candidate.streamId === 1, 5_000);
    expect([...frame.payload]).toEqual([0x68, 0x69]);
    expect(client.timeline.slice(0, 2)).toEqual([`response:${answer.id}`, "binary:1"]);
  });

  it("answers internal, sends no binary frame and closes the stream when the handler throws after opening one", async () => {
    const client = await connect();
    expect(await call(client, "openThenThrow")).toMatchObject({ ok: false, error: { code: "internal" } });
    await call(client);
    expect(client.timeline.filter((entry) => entry.startsWith("binary"))).toEqual([]);
    expect(events).toEqual(["close"]);
  });

  it("never commits a stream when the handler answers ok:false instead of throwing", async () => {
    const client = await connect();
    expect(await call(client, "openThenFail")).toMatchObject({ ok: false, error: { code: "not_found" } });
    await call(client);
    expect(client.timeline.filter((entry) => entry.startsWith("binary"))).toEqual([]);
    expect(events).toEqual(["close"]);
  });

  it("keeps the socket after a malformed binary frame and still answers JSON", async () => {
    const client = await connect();
    client.sendBinary(Uint8Array.of(1, 2, 3));
    client.sendBinary(encodeFrame({ op: FRAME_OPS.input, streamId: 42, seq: 0, payload: Uint8Array.of(1) }));
    expect(await call(client)).toMatchObject({ ok: true });
  });

  it("delivers input to the stream it names", async () => {
    const client = await connect();
    await call(client, "open");
    await client.waitForBinary(() => true, 5_000);
    client.sendBinary(
      encodeFrame({ op: FRAME_OPS.input, streamId: 1, seq: 7, payload: Uint8Array.of(0x6c, 0x73) }),
    );
    await vi.waitFor(() => expect(inputs).toEqual(["7:ls"]), { timeout: 5_000 });
  });

  it("closes with 4401 and runs onClose when the credential ends between two binary frames", async () => {
    const client = await connect();
    await call(client, "open");
    await client.waitForBinary(() => true, 5_000);
    session = "gone";
    client.sendBinary(encodeFrame({ op: FRAME_OPS.input, streamId: 1, seq: 0, payload: Uint8Array.of(1) }));
    expect(await client.closed).toBe(CLOSE_UNAUTHENTICATED);
    // revoke() runs first: hub.close, then the streams' onClose; the socket's own close comes after.
    await vi.waitFor(() => expect(events).toEqual(["open", "hub.close", "close", "hub.close"]), {
      timeout: 5_000,
    });
    expect(inputs).toEqual([]);
  });

  it("drops the frame, logs and keeps the socket when the credential check throws on a binary frame", async () => {
    const client = await connect();
    await call(client, "open");
    await client.waitForBinary(() => true, 5_000);
    failNextCheck = true;
    client.sendBinary(encodeFrame({ op: FRAME_OPS.input, streamId: 1, seq: 0, payload: Uint8Array.of(1) }));
    expect(await call(client)).toMatchObject({ ok: true });
    expect(inputs).toEqual([]);
    expect(logLines.filter((line) => line.msg === "ws_authenticate_failed")).toHaveLength(1);
    client.sendBinary(
      encodeFrame({ op: FRAME_OPS.input, streamId: 1, seq: 1, payload: Uint8Array.of(0x61) }),
    );
    await vi.waitFor(() => expect(inputs).toEqual(["1:a"]), { timeout: 5_000 });
  });

  it("drops a frame for a stream another connection holds", async () => {
    const owner1 = await connect();
    const other = await connect();
    await call(owner1, "open");
    await owner1.waitForBinary(() => true, 5_000);
    other.sendBinary(encodeFrame({ op: FRAME_OPS.input, streamId: 1, seq: 0, payload: Uint8Array.of(1) }));
    expect(await call(other)).toMatchObject({ ok: true });
    expect(inputs).toEqual([]);
    const drops = logLines.filter((line) => line.msg === "ws_binary_dropped");
    expect(drops.map((line) => [line.count, line.reason])).toEqual([[1, "unknown_stream"]]);
    owner1.sendBinary(
      encodeFrame({ op: FRAME_OPS.input, streamId: 1, seq: 1, payload: Uint8Array.of(0x62) }),
    );
    await vi.waitFor(() => expect(inputs).toEqual(["1:b"]), { timeout: 5_000 });
  });

  it("runs onClose when the client closes", async () => {
    const client = await connect();
    await call(client, "open");
    await client.waitForBinary(() => true, 5_000);
    client.close();
    await client.closed;
    await vi.waitFor(() => expect(events).toEqual(["open", "hub.close", "close"]), { timeout: 5_000 });
  });

  it("runs onClose for every stream when the server closes", async () => {
    const client = await connect();
    await call(client, "open");
    await call(client, "open");
    await vi.waitFor(() => expect(events.filter((event) => event === "open")).toHaveLength(2), {
      timeout: 5_000,
    });
    // closeAll is synchronous: both streams are closed when `close()` returns, before any socket event.
    ws.close();
    expect(events.filter((event) => event === "close")).toHaveLength(2);
  });
});
