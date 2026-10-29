import {
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { PapError } from "@pap/contracts";
import type { Clock } from "../../clock.ts";
import {
  cleanRequestHeaders,
  cleanResponseHeaders,
  rawRefusal,
  untrustedHeaders,
  upgradeHead,
} from "./headers.ts";
import {
  BodyTooLarge,
  type BoxSlots,
  bodyMeter,
  idleWatch,
  OpenBusy,
  type OpenQueue,
  PREVIEW_LIMITS,
  type PreviewRefusal,
} from "./limits.ts";
import type { PreviewTarget } from "./target.ts";

export interface ServiceGrant {
  readonly kind: "service";
  readonly box: string;
  readonly port: number;
  readonly sources: readonly string[];
  open(): Promise<Duplex>;
}

export type ServiceTarget = Extract<PreviewTarget, { kind: "service" | "artifact" }>;

export interface RelayHooks {
  readonly clock: Clock;
  readonly slots: BoxSlots;
  readonly queue: OpenQueue;
  /** An HTTP refusal: logged, counted for the box, answered with the no-network headers. */
  refuse(
    res: ServerResponse,
    status: number,
    reason: PreviewRefusal,
    token: string,
    box: string | null,
  ): void;
  /** A refusal counted and logged where no `ServerResponse` exists (an upgrade socket, an idle cut). */
  refused(reason: PreviewRefusal, token: string, box: string | null): void;
  /** One relayed request or WebSocket is over. */
  served(box: string, status: number, bytes: number): void;
  /** Relayed bytes moved: the box is touched (throttled by the listener). */
  touch(box: string): void;
  /** An error worth a debug line: its name only, never its message or the service's text. */
  note(event: string, error: unknown): void;
  /** Registers a way to cut a live relay at `close()`; returns the unregister. */
  track(cut: () => void): () => void;
}

/** A refusal written on a raw socket, then the socket is destroyed: sockets are half-open and a client that never ends would hold it. */
export const endRefusal = (socket: Duplex, text: string): void =>
  void socket.end(text, () => socket.destroy());

/** The request declared a body that has not all arrived yet (`req.complete` alone is false for a bodyless request until it is read). */
export const bodyOwed = (req: IncomingMessage): boolean =>
  !req.complete &&
  ((req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
    req.headers["transfer-encoding"] !== undefined);

const ABSENT = Symbol("absent");
const TOKEN_LIST = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*,\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+)*$/;
const METHOD = /^[A-Z]{1,16}$/;
const MAX_PREFLIGHT_HEADERS = 1024;

/** A box that stopped under an open is a 503, not a broken service (T7): the pane shows the box is stopped. */
const boxStopped = (error: unknown): boolean => error instanceof PapError && error.code === "box_stopped";

const header = (value: string | string[] | undefined): string | typeof ABSENT =>
  typeof value === "string" ? value : ABSENT;

/** What the page asked in a preflight the service did not answer: the requested method and headers, nothing else (UX2-R5). */
function preflightAnswer(request: IncomingMessage, csp: string): Record<string, string> {
  const out: Record<string, string> = { ...untrustedHeaders(csp), "content-length": "0" };
  const method = header(request.headers["access-control-request-method"]);
  if (method !== ABSENT && METHOD.test(method)) out["access-control-allow-methods"] = method;
  const asked = header(request.headers["access-control-request-headers"]);
  if (asked !== ABSENT && asked.length <= MAX_PREFLIGHT_HEADERS && TOKEN_LIST.test(asked))
    out["access-control-allow-headers"] = asked;
  return out;
}

const isPreflight = (req: IncomingMessage): boolean =>
  req.method === "OPTIONS" && typeof req.headers["access-control-request-method"] === "string";

/**
 * The body framing the service gets, set from what Node parsed and applied after the header cleaning, so a `Connection` list
 * naming `content-length` cannot remove it: a body is never sent unframed (it would be read as the next request).
 */
function framed(headers: OutgoingHttpHeaders, req: IncomingMessage): OutgoingHttpHeaders {
  const length = req.headers["content-length"];
  if (length !== undefined) return { ...headers, "content-length": length };
  if (req.headers["transfer-encoding"] !== undefined) return { ...headers, "transfer-encoding": "chunked" };
  return headers;
}

/** One request, one tunnel (UX2-R2): a live place of the box, the open queue, then `Connection: close` to the service. */
export function relayRequest(
  hooks: RelayHooks,
  req: IncomingMessage,
  res: ServerResponse,
  target: ServiceTarget,
  grant: ServiceGrant,
  csp: string,
): void {
  const { token, prefix, rest } = target;
  const { box } = grant;
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > PREVIEW_LIMITS.bodyBytes) return hooks.refuse(res, 413, "too_large", token, box);
  const release = hooks.slots.take(box);
  if (release === null) return hooks.refuse(res, 503, "busy", token, box);

  const abort = new AbortController();
  const meter = bodyMeter(PREVIEW_LIMITS.bodyBytes);
  let tunnel: Duplex | undefined;
  let upstream: ClientRequest | undefined;
  let status = 0;
  let sent = 0;
  let over = false;
  const cut = (): void => {
    res.destroy();
  };
  const idle = idleWatch(hooks.clock, PREVIEW_LIMITS.idleMs, () => {
    hooks.refused("idle", token, box);
    cut();
  });
  const untrack = hooks.track(cut);
  res.once("close", () => {
    if (over) return;
    over = true;
    idle.stop();
    untrack();
    release();
    abort.abort();
    upstream?.destroy();
    tunnel?.destroy();
    if (status !== 0) hooks.served(box, status, meter.bytes() + sent);
  });
  // Paused until the pipe below: a `data` listener alone would start the flow and lose what arrives while the tunnel opens.
  req.pause();
  req.on("data", () => idle.touch());

  const fail = (reason: PreviewRefusal, answer: 502 | 503): void => {
    if (over) return;
    hooks.refuse(res, answer, reason, token, box);
  };

  hooks.queue
    .run(box, () => grant.open(), abort.signal)
    .then(
      (opened) => {
        if (over) return void opened.destroy();
        tunnel = opened;
        opened.on("error", () => {});
        forward(opened);
      },
      (error: unknown) => {
        if (error instanceof OpenBusy) fail("busy", 503);
        else if (boxStopped(error)) fail("box_stopped", 503);
        else {
          hooks.note("preview_open_failed", error);
          fail("upstream_failed", 502);
        }
      },
    )
    .catch((error: unknown) => {
      hooks.note("preview_relay_failed", error);
      cut();
    });

  function forward(opened: Duplex): void {
    const requestPath = rest.split("?", 1)[0] ?? rest;
    try {
      upstream = request({
        createConnection: () => opened,
        method: req.method,
        path: rest,
        headers: framed(
          cleanRequestHeaders(req.headers, { port: grant.port, prefix, websocket: false }),
          req,
        ),
      });
    } catch {
      return fail("upstream_failed", 502);
    }
    upstream.on("error", (error) => {
      hooks.note("preview_upstream_error", error);
      if (res.headersSent) res.destroy();
      else fail("upstream_failed", 502);
    });
    upstream.on("response", (answer) => {
      idle.touch();
      status = answer.statusCode ?? 502;
      try {
        if (isPreflight(req) && answer.headers["access-control-allow-methods"] === undefined) {
          status = 204;
          answer.destroy();
          res.writeHead(204, {
            ...preflightAnswer(req, csp),
            ...(bodyOwed(req) ? { connection: "close" } : {}),
          });
          return void res.end();
        }
        const headers = cleanResponseHeaders(answer.headers, { prefix, port: grant.port, requestPath, csp });
        // Answered before the request body was read: the connection ends after the answer, so a body trickled forever is cut.
        res.writeHead(status, bodyOwed(req) ? { ...headers, connection: "close" } : headers);
      } catch {
        status = 0;
        answer.destroy();
        return fail("upstream_failed", 502);
      }
      answer.on("data", (chunk: Buffer) => {
        sent += chunk.length;
        idle.touch();
        hooks.touch(box);
      });
      answer.on("error", () => res.destroy());
      answer.on("aborted", () => res.destroy());
      answer.pipe(res);
    });
    meter.on("error", (error: Error) => {
      upstream?.destroy();
      if (error instanceof BodyTooLarge && !res.headersSent) hooks.refuse(res, 413, "too_large", token, box);
      else res.destroy();
    });
    req.on("error", () => res.destroy());
    req.pipe(meter).pipe(upstream);
  }
}

/** A WebSocket handshake relayed to the service: only a `101` reaches the browser's socket (UX2-R52). */
export function relayUpgrade(
  hooks: RelayHooks,
  req: IncomingMessage,
  socket: Duplex,
  target: ServiceTarget,
  grant: ServiceGrant,
  csp: string,
): void {
  const { token, prefix, rest } = target;
  const { box } = grant;
  const answerWith = (status: 403 | 404 | 413 | 502 | 503, reason: PreviewRefusal): void => {
    hooks.refused(reason, token, box);
    endRefusal(socket, rawRefusal(status, csp));
  };
  const release = hooks.slots.take(box);
  if (release === null) return answerWith(503, "busy");

  const abort = new AbortController();
  let tunnel: Duplex | undefined;
  let upstream: ClientRequest | undefined;
  let upgraded = false;
  let moved = 0;
  let over = false;
  const cut = (): void => void socket.destroy();
  const idle = idleWatch(hooks.clock, PREVIEW_LIMITS.idleMs, () => {
    hooks.refused("idle", token, box);
    cut();
  });
  const untrack = hooks.track(cut);
  socket.once("close", () => {
    if (over) return;
    over = true;
    idle.stop();
    untrack();
    release();
    abort.abort();
    upstream?.destroy();
    tunnel?.destroy();
    if (upgraded) hooks.served(box, 101, moved);
  });
  const count = (chunk: Buffer): void => {
    moved += chunk.length;
    idle.touch();
    hooks.touch(box);
  };

  hooks.queue
    .run(box, () => grant.open(), abort.signal)
    .then(
      (opened) => {
        if (over) return void opened.destroy();
        tunnel = opened;
        opened.on("error", () => {});
        forward(opened);
      },
      (error: unknown) => {
        if (!(error instanceof OpenBusy) && !boxStopped(error)) hooks.note("preview_open_failed", error);
        if (over) return;
        if (error instanceof OpenBusy) answerWith(503, "busy");
        else if (boxStopped(error)) answerWith(503, "box_stopped");
        else answerWith(502, "upstream_failed");
      },
    )
    .catch((error: unknown) => {
      hooks.note("preview_relay_failed", error);
      cut();
    });

  function forward(opened: Duplex): void {
    try {
      upstream = request({
        createConnection: () => opened,
        method: "GET",
        path: rest,
        headers: cleanRequestHeaders(req.headers, { port: grant.port, prefix, websocket: true }),
      });
    } catch {
      return answerWith(502, "upstream_failed");
    }
    upstream.on("error", (error) => {
      hooks.note("preview_upstream_error", error);
      if (upgraded) socket.destroy();
      else answerWith(502, "upstream_failed");
    });
    upstream.once("response", (answer) => {
      answer.destroy();
      answerWith(502, "upstream_failed");
    });
    upstream.once("upgrade", (answer, upSocket, upHead) => {
      if (answer.statusCode !== 101 || String(answer.headers.upgrade).toLowerCase() !== "websocket") {
        upSocket.destroy();
        return answerWith(502, "upstream_failed");
      }
      upgraded = true;
      upSocket.on("error", () => socket.destroy());
      upSocket.on("close", () => socket.destroy());
      socket.write(upgradeHead(answer.headers));
      if (upHead.length > 0) socket.write(upHead);
      socket.on("data", count);
      upSocket.on("data", count);
      socket.pipe(upSocket);
      upSocket.pipe(socket);
    });
    upstream.end();
  }
}
