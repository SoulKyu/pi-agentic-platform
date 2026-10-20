import http from "node:http";
import https from "node:https";
import { Transform, pipeline } from "node:stream";
import { AGENT_NET } from "@pap/contracts";
import type { ResolvedProvider } from "./credentials.ts";
import { upstreamHeaders, type UpstreamCredential } from "./headers.ts";
import { presentedKey, type RelayKeys } from "./keys.ts";
import type { RelayPolicy } from "./policy.ts";
import { modelOf, modelSourceOf, pathAllowed, routeOf, type RelayRoute } from "./routes.ts";
import type { RelayUsage } from "./usage.ts";

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_CONCURRENT_PER_ADDRESS = 8;
/** An upstream that sends nothing for this long is cut (5 minutes). */
export const UPSTREAM_IDLE_MS = 300_000;
const CLAUDE_UPSTREAM = "https://api.anthropic.com";
/** The only addresses the relay listens on: the bridge's host address, or loopback (process backend, tests). Never a wildcard. */
const BINDABLE: ReadonlySet<string> = new Set([AGENT_NET.host, "127.0.0.1"]);
/** A header that must come once: Node keeps the first of some duplicates and joins others, so the raw list is judged. */
const ONCE = new Set([
  "host",
  "content-length",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "content-type",
]);
/** What an upstream answer may carry to a VM: content framing, retry and rate-limit hints, request ids. Nothing else. */
const ANSWER_HEADERS =
  /^(?:content-[a-z-]+|retry-after(?:-ms)?|x-ratelimit-[a-z-]+|anthropic-ratelimit-[a-z-]+|request-id|x-request-id|x-should-retry)$/;
/** Most connections one source address may hold open (a VM needs a handful: 8 requests at once plus keep-alives). */
export const MAX_CONNECTIONS_PER_ADDRESS = 32;
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 120_000;

export interface RelayServerDeps {
  readonly keys: RelayKeys;
  readonly policy: RelayPolicy;
  readonly usage: RelayUsage;
  resolveProvider(provider: string, model: string): Promise<ResolvedProvider | null>;
  /** The owner's `claude setup-token` value, or null (answered 503 on `claude.internal`). */
  claudeToken(): string | null;
  /** One log line; callers never put a key, token, path or host in it. */
  log(line: string): void;
  readonly claudeUpstream?: string;
  readonly upstreamIdleMs?: number;
}

type Reason =
  | "route"
  | "busy"
  | "key"
  | "model"
  | "paused"
  | "budget"
  | "provider"
  | "too_large"
  | "request"
  | "no_claude_token"
  | "upstream";
const STATUS: Readonly<Record<Reason, number>> = {
  route: 403,
  busy: 429,
  key: 403,
  model: 403,
  paused: 403,
  budget: 403,
  provider: 403,
  too_large: 413,
  request: 400,
  no_claude_token: 503,
  upstream: 502,
};

/** `host:port` of the one place the relay may listen. Anything else, wildcards first, is refused (AVM-P10). */
export function parseListen(text: string): { host: string; port: number } {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(text);
  const host = match?.[1];
  const port = Number(match?.[2]);
  if (host === undefined || !BINDABLE.has(host) || port > 65_535) throw new RangeError("listen address");
  return { host, port };
}

/** Listens on a bindable address only (never `0.0.0.0` or `::`) and answers the port. */
export async function listenOn(server: http.Server, host: string, port: number): Promise<number> {
  if (!BINDABLE.has(host)) throw new RangeError("listen address");
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve((server.address() as { port: number }).port);
    });
  });
}

const duplicated = (rawHeaders: readonly string[]): boolean => {
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] as string).toLowerCase();
    if (!ONCE.has(name)) continue;
    if (seen.has(name)) return true;
    seen.add(name);
  }
  return false;
};

/** The whole body, or "too_large" at the limit, or null when the client went away first. */
function readBody(req: http.IncomingMessage): Promise<Buffer | "too_large" | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (value: Buffer | "too_large" | null): void => {
      req.off("data", onData);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return done("too_large");
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => done(Buffer.concat(chunks)));
    req.once("error", () => done(null));
    req.once("close", () => done(null));
  });
}

/**
 * The provider relay (R13, spec §9). For each request, in order: the route table, at most 8 requests at once per
 * address, the launch's relay key from the VM's own address, the whole body (32 MiB), the agent's model and its
 * state; only then a credential is resolved and the request forwarded over TLS, never followed to a redirect. Every
 * refusal is a fixed JSON body and a log line of agent and reason: no key, token, path or host is in either.
 */
export function createRelayServer(deps: RelayServerDeps): http.Server {
  const active = new Map<string, number>();
  const idleMs = deps.upstreamIdleMs ?? UPSTREAM_IDLE_MS;
  // The responses a launch's key has open: a revoke ends them (T12), the upstream request closes with its response.
  const open = new Map<string, Set<http.ServerResponse>>();
  deps.keys.onRemove((launchId) => {
    for (const res of open.get(launchId) ?? []) res.destroy();
    open.delete(launchId);
  });

  const refuse = (res: http.ServerResponse, reason: Reason, agentId: string | null): void => {
    deps.log(`agent_relay_refused ${JSON.stringify({ agentId, reason })}`);
    if (agentId !== null) deps.usage.refused(agentId);
    answer(res, reason);
  };
  const answer = (res: http.ServerResponse, reason: Reason): void => {
    if (res.headersSent) return void res.destroy();
    const body = JSON.stringify({ error: reason });
    res.writeHead(STATUS[reason], {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  };

  function forward(
    res: http.ServerResponse,
    agentId: string,
    target: { base: string; route: RelayRoute },
    headers: Record<string, string>,
    body: Buffer,
  ): void {
    let url: URL;
    try {
      url = new URL(`${target.base.replace(/\/+$/, "")}${target.route.path}${target.route.query}`);
    } catch {
      return answer(res, "upstream");
    }
    const client = url.protocol === "https:" ? https : http;
    const upstream = client.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, "content-length": String(body.length) },
      timeout: idleMs,
      agent: false,
      // Explicit: an inherited NODE_TLS_REJECT_UNAUTHORIZED=0 must not turn certificate checks off.
      rejectUnauthorized: true,
    });
    const failed = (): void => {
      deps.log(`agent_relay_failed ${JSON.stringify({ agentId, reason: "upstream" })}`);
      answer(res, "upstream");
    };
    upstream.once("timeout", () => upstream.destroy(new Error("idle")));
    upstream.once("error", failed);
    res.once("close", () => upstream.destroy());
    upstream.once("response", (incoming) => {
      upstream.off("error", failed);
      upstream.on("error", () => res.destroy());
      const out: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(incoming.headers))
        if (ANSWER_HEADERS.test(name) && value !== undefined) out[name] = value;
      res.writeHead(incoming.statusCode ?? 502, out);
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, next) {
          bytes += chunk.length;
          next(null, chunk);
        },
      });
      pipeline(incoming, counter, res, () => {
        deps.usage.finished(agentId, { bytesOut: bytes });
        res.destroy();
      });
    });
    upstream.end(body);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (duplicated(req.rawHeaders)) return refuse(res, "request", null);
    const route = routeOf(req.method, req.headers.host, req.url);
    if (route === null) return refuse(res, "route", null);
    const address = req.socket.remoteAddress ?? "";
    const running = active.get(address) ?? 0;
    if (running >= MAX_CONCURRENT_PER_ADDRESS) return refuse(res, "busy", null);
    active.set(address, running + 1);
    res.once("close", () => {
      const left = (active.get(address) ?? 1) - 1;
      if (left <= 0) active.delete(address);
      else active.set(address, left);
    });
    const grant = deps.keys.grantOf(presentedKey(req.headers), req.socket.remoteAddress);
    if (grant === null) return refuse(res, "key", null);
    const { agentId, launchId } = grant;
    const mine = open.get(launchId) ?? new Set<http.ServerResponse>();
    mine.add(res);
    open.set(launchId, mine);
    res.once("close", () => {
      mine.delete(res);
      if (mine.size === 0 && open.get(launchId) === mine) open.delete(launchId);
    });
    const declared = Number(req.headers["content-length"] ?? 0);
    const body = declared > MAX_BODY_BYTES ? "too_large" : await readBody(req);
    if (body === null) return;
    if (body === "too_large") {
      res.setHeader("connection", "close");
      res.once("finish", () => req.socket.destroy());
      return refuse(res, "too_large", agentId);
    }
    // A key revoked or rotated while the body arrived is not served.
    if (deps.keys.grantOf(presentedKey(req.headers), req.socket.remoteAddress)?.launchId !== launchId)
      return refuse(res, "key", null);
    deps.usage.request(agentId, { bytesIn: body.length });
    const model = modelOf(modelSourceOf(route.path), route.path, body);
    const verdict = deps.policy.check(agentId, {
      provider: route.kind === "provider" ? route.provider : null,
      model,
    });
    if (!verdict.ok) return refuse(res, verdict.reason, agentId);
    // The policy never allows a missing model; this keeps the type honest and fails closed.
    if (model === null) return refuse(res, "model", agentId);
    if (route.kind === "claude") {
      const token = deps.claudeToken();
      if (token === null) return refuse(res, "no_claude_token", agentId);
      const credential: UpstreamCredential = { value: token, headers: {} };
      return forward(
        res,
        agentId,
        { base: deps.claudeUpstream ?? CLAUDE_UPSTREAM, route },
        upstreamHeaders("claude", req.headers, credential),
        body,
      );
    }
    let resolved: ResolvedProvider | null;
    try {
      resolved = await deps.resolveProvider(route.provider, model);
    } catch {
      resolved = null;
    }
    // The wait above can last seconds (a `!command` key, an OAuth refresh): a revoke, a pause or a budget reached meanwhile counts.
    if (
      res.destroyed ||
      deps.keys.grantOf(presentedKey(req.headers), req.socket.remoteAddress)?.launchId !== launchId
    )
      return;
    const again = deps.policy.check(agentId, { provider: route.provider, model });
    if (!again.ok) return refuse(res, again.reason, agentId);
    if (resolved === null) return refuse(res, "provider", agentId);
    if (!pathAllowed(resolved.api, route.path)) return refuse(res, "route", agentId);
    forward(
      res,
      agentId,
      { base: resolved.baseUrl, route },
      upstreamHeaders(resolved.api, req.headers, resolved.credential),
      body,
    );
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      deps.log(`agent_relay_failed ${JSON.stringify({ agentId: null, reason: "internal" })}`);
      answer(res, "upstream");
    });
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  const sockets = new Map<string, number>();
  server.on("connection", (socket) => {
    const address = socket.remoteAddress ?? "";
    const open = sockets.get(address) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_ADDRESS) {
      deps.log(`agent_relay_refused ${JSON.stringify({ agentId: null, reason: "busy" })}`);
      return void socket.destroy();
    }
    sockets.set(address, open + 1);
    socket.once("close", () => {
      const left = (sockets.get(address) ?? 1) - 1;
      if (left <= 0) sockets.delete(address);
      else sockets.set(address, left);
    });
  });
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    // A client that reset its connection is not a refusal.
    if (error.code === "ECONNRESET") return void socket.destroy();
    deps.log(`agent_relay_refused ${JSON.stringify({ agentId: null, reason: "request" })}`);
    if (socket.writable)
      socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    else socket.destroy();
  });
  return server;
}
