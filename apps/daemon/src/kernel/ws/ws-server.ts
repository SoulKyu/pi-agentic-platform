import { randomUUID } from "node:crypto";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  CAPABILITIES,
  MAX_FRAME_BYTES,
  PapError,
  PROTOCOL_VERSION,
  RequestFrame,
  type Caller,
  type Cursor,
  type StreamName,
} from "@pap/contracts";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Clock, TimerHandle } from "../clock.ts";
import { originAllowed, type OriginRefused } from "../http/origin.ts";
import type { Logger } from "../logger.ts";
import type { Dispatch } from "./dispatcher.ts";
import type { PreparedOpen, StreamHub } from "./stream-hub.ts";

/** Server ping interval and the silence window after which a peer counts as dead (spec C 4.2). */
export const KEEPALIVE_MS = 15_000;
/** How long a closing server waits for a peer to answer the 1001 close before it cuts the socket. */
export const CLOSE_GRACE_MS = 1_000;
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** Open subscriptions one connection may hold; the next one is answered `capacity`. */
export const MAX_SUBSCRIPTIONS = 64;
/**
 * Close code of a socket whose session ended (sign-out, expiry) while it was open. Application codes start at 4000;
 * 4401 mirrors HTTP 401. A client that sees it must sign in again before it reconnects.
 */
export const CLOSE_UNAUTHENTICATED = 4401;

export interface WsServerOptions {
  readonly allowedOrigins: ReadonlySet<string>;
  /**
   * Resolves the session cookie header to a caller. Asked at the upgrade, before every request frame and on every
   * keepalive tick, so a sign-out or an expiry ends an open socket within one request or one tick. It may throw
   * (database trouble): the upgrade answers 500, a request frame answers `internal`, a tick leaves the socket for
   * the next check.
   */
  authenticate(cookieHeader: string | undefined): Caller | null;
  readonly dispatch: Dispatch;
  readonly hub: StreamHub;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly serverVersion: string;
  /** Called for every upgrade refused for its Origin. */
  readonly onOriginRefused?: OriginRefused;
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
 * `onWindow` runs at the end of every window a live peer survived (the session re-check).
 */
export function startKeepalive(peer: KeepalivePeer, clock: Clock, onWindow?: () => void): { stop(): void } {
  let heard = false;
  let stopped = false;
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
    // The callback may end the connection and stop this chain; it must not throw out of the timer.
    onWindow?.();
    if (!stopped) probe();
  };
  probe();
  return {
    stop() {
      stopped = true;
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

  /**
   * `cookie` is the Cookie header of the upgrade, kept for the life of the socket and used for nothing but the
   * re-checks below. It is never logged or sent anywhere.
   */
  function attach(ws: WebSocket, cookie: string | undefined): void {
    const connectionId = randomUUID();
    let nextSub = 0;
    let revoked = false;
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

    // Subscriptions of this connection, committed or still waiting for their response to go out.
    const subs = new Set<string>();
    const release = (sub: string): void => {
      subs.delete(sub);
      options.hub.close(connectionId, sub);
    };

    // The session ended: live events stop at once, the close frame follows whatever was already queued.
    const revoke = (): void => {
      if (revoked) return;
      revoked = true;
      options.hub.close(connectionId);
      subs.clear();
      if (ws.readyState === ws.CLOSED) return;
      ws.close(CLOSE_UNAUTHENTICATED, "unauthenticated");
      const cut = options.clock.setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
      ws.once("close", () => options.clock.clearTimeout(cut));
    };

    const onText = async (text: string): Promise<void> => {
      if (revoked) return;
      let requestId: number | null = null;
      let answered = false;
      let committed = false;
      const prepared: Array<{ readonly sub: string; readonly open: PreparedOpen }> = [];
      try {
        const frame = decode(text, sendSafe);
        requestId = frame?.id ?? null;
        // Every text frame re-asks, a malformed one too: a revoked socket must not linger on garbage.
        const caller = options.authenticate(cookie);
        if (!caller) {
          if (frame) sendSafe({ id: frame.id, ok: false, error: { code: "unauthenticated" } });
          answered = true;
          revoke();
          return;
        }
        if (!frame) return;
        const response = await options.dispatch(frame, {
          caller,
          connectionId,
          // The replay or snapshot is built here, inside the handler, so a failure becomes this
          // request's error response. Nothing reaches the client before the response does.
          openSubscription(stream: StreamName, key: string, after: Cursor | undefined) {
            if (subs.size >= MAX_SUBSCRIPTIONS) throw new PapError("capacity");
            const sub = `s${nextSub + 1}`;
            const open = options.hub.prepare({ connectionId, sub, stream, key, after, send: sendSafe });
            nextSub++;
            subs.add(sub);
            prepared.push({ sub, open });
            return sub;
          },
          closeSubscription: release,
        });
        send(response);
        answered = true;
        // The client learns its `sub` from the response, so the snapshot must come after it.
        if (response.ok && ws.readyState === ws.OPEN) {
          committed = true;
          for (const { open } of prepared) open.commit();
        }
      } catch (error) {
        options.logger.error("ws_message_failed", { connectionId, err: error });
        if (requestId !== null && !answered)
          sendSafe({ id: requestId, ok: false, error: { code: "internal" } });
      } finally {
        if (!committed) for (const { sub } of prepared) release(sub);
      }
    };

    const keepalive = startKeepalive(ws, options.clock, () => {
      try {
        if (!options.authenticate(cookie)) {
          keepalive.stop();
          revoke();
        }
      } catch (error) {
        // Cannot tell: keep the socket, the next frame or tick asks again. No request is served meanwhile.
        options.logger.error("ws_authenticate_failed", { connectionId, err: error });
      }
    });
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
      if (!originAllowed(req.headers.origin, options.allowedOrigins)) {
        options.onOriginRefused?.("ws", req.headers.origin);
        return reject(socket, 403);
      }
      if (url.searchParams.get("proto") !== String(PROTOCOL_VERSION)) return reject(socket, 426);
      let caller: Caller | null;
      try {
        caller = options.authenticate(req.headers.cookie);
      } catch (error) {
        options.logger.error("ws_authenticate_failed", { err: error });
        return reject(socket, 500);
      }
      if (!caller) return reject(socket, 401);
      const cookie = req.headers.cookie;
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, cookie));
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
