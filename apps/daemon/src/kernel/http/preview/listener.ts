import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Clock, TimerHandle } from "../../clock.ts";
import type { Logger } from "../../logger.ts";
import { artifactCsp, serviceCsp } from "./csp.ts";
import { rawRefusal, untrustedHeaders } from "./headers.ts";
import {
  createBoxSlots,
  createOpenQueue,
  createRefusalLog,
  PREVIEW_LIMITS,
  type PreviewRefusal,
} from "./limits.ts";
import {
  bodyOwed,
  endRefusal,
  type RelayHooks,
  relayRequest,
  relayUpgrade,
  type ServiceGrant,
} from "./relay.ts";
import { parsePreviewTarget } from "./target.ts";

export type ListenerGrant = ServiceGrant | { readonly kind: "artifact"; readonly html: string };

export interface PreviewListenerDeps {
  readonly appOrigins: readonly string[];
  /** The preview origin once the port is bound (`previewOriginOf`, T3): every CSP names it (UX2-R53). */
  previewOrigin(boundPort: number): string;
  grantOf(kind: "service" | "artifact", token: string): ListenerGrant | null;
  onTraffic?(box: string): void;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** An error in a log line: its name, never its message (which may carry a path, an address or the service's text). */
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

const USAGE_EVERY_MS = 60_000;
const TRAFFIC_EVERY_MS = 10_000;

interface Usage {
  requests: number;
  bytes: number;
  refusals: number;
}

export function createPreviewListener(deps: PreviewListenerDeps): {
  listen(host: string, port: number, tls: { cert: Buffer; key: Buffer } | null): Promise<{ port: number }>;
  close(): Promise<void>;
} {
  const logRefusal = createRefusalLog(deps.logger, deps.clock);
  const slots = createBoxSlots(PREVIEW_LIMITS.tunnelsPerBox);
  const queue = createOpenQueue({
    clock: deps.clock,
    inFlight: PREVIEW_LIMITS.opensPerBox,
    waiting: PREVIEW_LIMITS.openWaitersPerBox,
    waitMs: PREVIEW_LIMITS.openWaitMs,
  });
  const usage = new Map<string, Usage>();
  const touched = new Map<string, number>();
  const live = new Set<() => void>();
  let origin = "";
  let server: Server | null = null;
  let usageTimer: TimerHandle | undefined;

  const usageOf = (box: string): Usage => {
    let entry = usage.get(box);
    if (entry === undefined) {
      entry = { requests: 0, bytes: 0, refusals: 0 };
      usage.set(box, entry);
    }
    return entry;
  };
  const noNetworkCsp = (): string =>
    serviceCsp({ appOrigins: deps.appOrigins, previewOrigin: origin, hosts: [] });

  function refused(reason: PreviewRefusal, token: string | null, box: string | null): void {
    logRefusal(reason, token);
    if (box !== null) usageOf(box).refusals++;
  }

  function refuse(
    res: ServerResponse,
    status: number,
    reason: PreviewRefusal,
    token: string | null,
    box: string | null = null,
  ): void {
    refused(reason, token, box);
    if (res.headersSent) return void res.destroy();
    // `Connection: close`: a refusal may leave a request body unread, and the connection is not worth keeping.
    res.writeHead(status, {
      ...untrustedHeaders(noNetworkCsp()),
      "content-length": "0",
      connection: "close",
    });
    res.end();
  }

  const hooks: RelayHooks = {
    clock: deps.clock,
    slots,
    queue,
    refuse,
    refused,
    served(box, status, bytes) {
      deps.logger.debug("preview_relay", { box, status, bytes });
      const entry = usageOf(box);
      entry.requests++;
      entry.bytes += bytes;
    },
    touch,
    note: (event, error) => deps.logger.debug(event, { error: nameOf(error) }),
    track(cut) {
      live.add(cut);
      return () => void live.delete(cut);
    },
  };

  /** A relayed request keeps its box awake, but at most once per 10 s (spec §4, Activity). */
  function touch(box: string): void {
    if (deps.onTraffic === undefined) return;
    const now = deps.clock.now();
    for (const [name, at] of touched) if (now - at >= TRAFFIC_EVERY_MS) touched.delete(name);
    if (touched.has(box)) return;
    touched.set(box, now);
    deps.onTraffic(box);
  }

  function serveArtifact(
    req: IncomingMessage,
    res: ServerResponse,
    rest: string,
    html: string,
    token: string,
  ): void {
    const dest = req.headers["sec-fetch-dest"];
    if (req.method !== "GET" && req.method !== "HEAD") return refuse(res, 404, "not_found", token);
    if (!(rest === "/" || rest.startsWith("/?"))) return refuse(res, 404, "not_found", token);
    // Framed by pap only: a top-level load would leave the page free to navigate itself away with what it holds.
    if (dest !== undefined && dest !== "iframe") return refuse(res, 404, "dest_refused", token);
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, {
      ...untrustedHeaders(artifactCsp(deps.appOrigins)),
      ...unreadClose(req),
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.length),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  /** Answered before the request body was read: the connection ends after the answer (a body trickled forever is cut). */
  const unreadClose = (req: IncomingMessage): Record<string, string> =>
    bodyOwed(req) ? { connection: "close" } : {};

  function dispatch(req: IncomingMessage, res: ServerResponse): void {
    const target = parsePreviewTarget(req.url);
    if (target === null) return refuse(res, 404, "not_found", null);
    const kind = target.kind === "slash" ? target.of : target.kind;
    const grant = deps.grantOf(kind, target.token);
    if (grant === null || grant.kind !== kind) return refuse(res, 404, "not_found", target.token);
    if (target.kind === "slash") {
      res.writeHead(308, {
        ...untrustedHeaders(noNetworkCsp()),
        ...unreadClose(req),
        location: target.location,
        "content-length": "0",
      });
      return void res.end();
    }
    if (grant.kind === "artifact") return serveArtifact(req, res, target.rest, grant.html, target.token);
    // Framed or fetched by the page only: loaded top-level, a sandboxed document may navigate itself anywhere (the artifact rule).
    if (req.headers["sec-fetch-dest"] === "document")
      return refuse(res, 404, "dest_refused", target.token, grant.box);
    touch(grant.box);
    const csp = serviceCsp({ appOrigins: deps.appOrigins, previewOrigin: origin, hosts: grant.sources });
    relayRequest(hooks, req, res, target, grant, csp);
  }

  function dispatchUpgrade(req: IncomingMessage, socket: Duplex): void {
    const refuseSocket = (status: 404, reason: PreviewRefusal, token: string | null): void => {
      refused(reason, token, null);
      endRefusal(socket, rawRefusal(status, noNetworkCsp()));
    };
    const target = parsePreviewTarget(req.url);
    if (target === null) return refuseSocket(404, "not_found", null);
    if (target.kind !== "service") return refuseSocket(404, "not_found", target.token);
    const grant = deps.grantOf("service", target.token);
    const websocket = String(req.headers.upgrade).toLowerCase() === "websocket";
    if (grant === null || grant.kind !== "service" || req.method !== "GET" || !websocket)
      return refuseSocket(404, "not_found", target.token);
    touch(grant.box);
    const csp = serviceCsp({ appOrigins: deps.appOrigins, previewOrigin: origin, hosts: grant.sources });
    relayUpgrade(hooks, req, socket, target, grant, csp);
  }

  // A synchronous throw while dispatching (a port or a bug) cuts that one connection and is logged by error name;
  // failures after the relay started are handled where they happen (relay.ts).
  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      dispatch(req, res);
    } catch (error) {
      deps.logger.error("preview_dispatch_failed", { error: nameOf(error) });
      res.destroy();
    }
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex): void {
    socket.on("error", () => socket.destroy());
    try {
      dispatchUpgrade(req, socket);
    } catch (error) {
      deps.logger.error("preview_dispatch_failed", { error: nameOf(error) });
      socket.destroy();
    }
  }

  function flushUsage(): void {
    for (const [box, entry] of usage)
      if (entry.requests > 0 || entry.refusals > 0) deps.logger.info("preview_usage", { box, ...entry });
    usage.clear();
  }
  function armUsage(): void {
    usageTimer = deps.clock.setTimeout(() => {
      flushUsage();
      armUsage();
    }, USAGE_EVERY_MS);
  }

  return {
    async listen(host, port, tls) {
      if (server !== null) throw new Error("the preview listener is already listening");
      const options = {
        headersTimeout: PREVIEW_LIMITS.headersMs,
        requestTimeout: 0,
        // The runtime checks the headers bound every 30 s by default: a 10 s bound is only as good as its check.
        connectionsCheckingInterval: 1000,
        ...(tls === null ? {} : { ...tls, handshakeTimeout: PREVIEW_LIMITS.headersMs }),
      };
      const created = tls === null ? createServer(options, onRequest) : createHttpsServer(options, onRequest);
      created.maxConnections = PREVIEW_LIMITS.listenerSockets;
      created.on("upgrade", onUpgrade);
      // Node answers an `Expect` other than `100-continue` itself, 417 and keep-alive, without any dispatch: the answer is ours.
      created.on("checkExpectation", (_req, res) => refuse(res, 417, "not_found", null));
      created.on("clientError", (_error, socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => {
        created.once("error", reject);
        created.listen(port, host, () => {
          created.off("error", reject);
          resolve();
        });
      });
      created.on("error", (error) => deps.logger.error("preview_listener_error", { error: nameOf(error) }));
      server = created;
      const bound = (created.address() as AddressInfo).port;
      origin = deps.previewOrigin(bound);
      armUsage();
      return { port: bound };
    },
    async close() {
      if (usageTimer !== undefined) deps.clock.clearTimeout(usageTimer);
      usageTimer = undefined;
      const closing = server;
      server = null;
      for (const cut of [...live]) cut();
      if (closing === null) return;
      await new Promise<void>((resolve) => {
        closing.closeAllConnections();
        closing.close(() => resolve());
      });
    },
  };
}
