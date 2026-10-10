import { randomUUID } from "node:crypto";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  CAPABILITIES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RequestFrame,
  type Caller,
  type Cursor,
  type StreamName,
} from "@pap/contracts";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Clock, TimerHandle } from "../clock.ts";
import { originAllowed } from "../http/origin.ts";
import type { Logger } from "../logger.ts";
import type { Dispatch } from "./dispatcher.ts";
import type { StreamHub } from "./stream-hub.ts";

/** Server ping interval and the silence window after which a peer counts as dead (spec C 4.2). */
export const KEEPALIVE_MS = 15_000;
/** How long a closing server waits for a peer to answer the 1001 close before it cuts the socket. */
export const CLOSE_GRACE_MS = 1_000;
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface WsServerOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  authenticate(req: IncomingMessage): Caller | null;
  readonly dispatch: Dispatch;
  readonly hub: StreamHub;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly serverVersion: string;
}

export interface WsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

export interface KeepalivePeer {
  ping(): void;
  terminate(): void;
  on(event: "message" | "ping" | "pong", listener: () => void): unknown;
}

/**
 * One timer chain per peer, one 15 s window. The server pings at the start of each window; a peer
 * from which nothing at all arrived during a whole window (no message, ping or pong) is terminated
 * when the window closes. Browsers answer pings below the page, so a throttled background tab lives.
 */
export function startKeepalive(peer: KeepalivePeer, clock: Clock): { stop(): void } {
  let heard = false;
  let timer: TimerHandle | null = null;
  for (const event of ["message", "ping", "pong"] as const) {
    peer.on(event, () => {
      heard = true;
    });
  }
  const probe = (): void => {
    try {
      peer.ping();
      timer = clock.setTimeout(tick, KEEPALIVE_MS);
    } catch {
      peer.terminate();
    }
  };
  const tick = (): void => {
    timer = null;
    if (!heard) {
      peer.terminate();
      return;
    }
    heard = false;
    probe();
  };
  probe();
  return {
    stop() {
      if (timer) clock.clearTimeout(timer);
      timer = null;
    },
  };
}

// The socket is destroyed once the refusal has been flushed (`finish`), not right after `end()`:
// an immediate destroy can drop the unsent response and the client then sees a bare reset.
function reject(socket: Duplex, status: number): void {
  socket.on("error", () => socket.destroy());
  socket.once("finish", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function upgradeUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", "http://pap.invalid");
  } catch {
    return null;
  }
}

/** Parses one text message. A malformed one is dropped, or answered `bad_request` when it has a usable id. */
function decode(text: string, reply: (frame: unknown) => void): RequestFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = RequestFrame.safeParse(raw);
  if (parsed.success) return parsed.data;
  const id = (raw as { id?: unknown } | null)?.id;
  if (typeof id === "number" && Number.isInteger(id) && id >= 0)
    reply({ id, ok: false, error: { code: "bad_request" } });
  return null;
}

export function createWsServer(options: WsServerOptions): WsServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  function attach(ws: WebSocket, caller: Caller): void {
    const connectionId = randomUUID();
    let nextSub = 0;
    const send = (frame: unknown): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        options.logger.warn("ws_slow_consumer", { connectionId });
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify(frame));
    };
    // For frames nobody can retry (stream events, error replies): a failure is logged, never thrown,
    // so it cannot break the publisher's loop over the other subscribers.
    const sendSafe = (frame: unknown): void => {
      try {
        send(frame);
      } catch (error) {
        options.logger.error("ws_send_failed", { connectionId, err: error });
      }
    };

    const onText = async (text: string): Promise<void> => {
      let requestId: number | null = null;
      let answered = false;
      try {
        const frame = decode(text, sendSafe);
        if (!frame) return;
        requestId = frame.id;
        const afterResponse: Array<() => void> = [];
        const response = await options.dispatch(frame, {
          caller,
          connectionId,
          openSubscription(stream: StreamName, key: string, after: Cursor | undefined) {
            const sub = `s${++nextSub}`;
            afterResponse.push(() => {
              try {
                options.hub.open({ connectionId, sub, stream, key, after, send: sendSafe });
              } catch (error) {
                options.logger.error("subscription_failed", { connectionId, stream, err: error });
              }
            });
            return sub;
          },
          closeSubscription(sub: string) {
            options.hub.close(connectionId, sub);
          },
        });
        send(response);
        answered = true;
        // The client learns its `sub` from the response, so the snapshot must come after it.
        if (response.ok && ws.readyState === ws.OPEN) for (const open of afterResponse) open();
      } catch (error) {
        options.logger.error("ws_message_failed", { connectionId, err: error });
        if (requestId !== null && !answered)
          sendSafe({ id: requestId, ok: false, error: { code: "internal" } });
      }
    };

    const keepalive = startKeepalive(ws, options.clock);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) void onText(data.toString());
    });
    ws.on("close", () => {
      keepalive.stop();
      options.hub.close(connectionId);
    });
    ws.on("error", (error) => options.logger.debug("ws_error", { connectionId, err: error }));
    send({
      protocol: PROTOCOL_VERSION,
      capabilities: [...CAPABILITIES],
      serverVersion: options.serverVersion,
    });
  }

  return {
    handleUpgrade(req, socket, head) {
      const url = upgradeUrl(req);
      if (!url) return reject(socket, 400);
      if (url.pathname !== "/ws") return reject(socket, 404);
      if (!originAllowed(req.headers.origin, options.allowedOrigins)) return reject(socket, 403);
      if (url.searchParams.get("proto") !== String(PROTOCOL_VERSION)) return reject(socket, 426);
      let caller: Caller | null;
      try {
        caller = options.authenticate(req);
      } catch (error) {
        options.logger.error("ws_authenticate_failed", { err: error });
        return reject(socket, 500);
      }
      if (!caller) return reject(socket, 401);
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, caller));
    },
    close() {
      for (const client of wss.clients) {
        client.close(1001, "going away");
        const cut = options.clock.setTimeout(() => client.terminate(), CLOSE_GRACE_MS);
        client.once("close", () => options.clock.clearTimeout(cut));
      }
      wss.close();
    },
  };
}
