import {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { EgressHost, EgressReason } from "@pap/contracts";
import type { Decision } from "./judge.ts";
import { displayHost, refusalBody, refusalStatus, UNREADABLE_HOST } from "./refusal.ts";

/** What the plain HTTP relay needs of its command: bookkeeping and the upstream, nothing else. */
export interface RelayContext {
  decide(kind: EgressHost["kind"], rawHost: string, port: number): Promise<Decision>;
  /** True while the client connection is still tracked (not closed, not ended). */
  alive(): boolean;
  /** Records a refusal or an allowed target in the command's report. */
  record(kind: EgressHost["kind"], port: number, decision: Decision): void;
  touch(direction: "up" | "down", bytes: number): void;
  upstreamFull(): boolean;
  /** Reserves a slot and connects to the first checked address that answers. Rejects when none does. */
  connectUpstream(ips: readonly string[], port: number): Promise<Socket>;
}

/** Headers that belong to one hop, not to the request being relayed. */
const DROPPED_HEADERS = ["proxy-connection", "proxy-authorization", "keep-alive", "upgrade", "expect"];

const forwarded = (headers: OutgoingHttpHeaders, set: OutgoingHttpHeaders): OutgoingHttpHeaders => ({
  ...Object.fromEntries(Object.entries(headers).filter(([name]) => !DROPPED_HEADERS.includes(name))),
  ...set,
});

/** One absolute-URI http request to port 80, any method (M11R235); the answer always closes the connection. */
export async function relayHttp(ctx: RelayContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const refuse = (reason: EgressReason, host: string, port: number): void => {
    ctx.record("http", port, { reason, host });
    const body = refusalBody(reason, host);
    res.writeHead(refusalStatus(reason), {
      "x-pap-deny": reason,
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      connection: "close",
    });
    res.end(body);
  };
  const url = req.url ?? "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    refuse(url === "*" ? "scheme" : "bad_request", UNREADABLE_HOST, 0);
    return;
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    refuse("bad_request", UNREADABLE_HOST, 0);
    return;
  }
  const port = Number(target.port || (target.protocol === "http:" ? 80 : 443));
  if (target.protocol !== "http:") {
    refuse("scheme", displayHost(target.hostname), port);
    return;
  }
  const decision = await ctx.decide("http", target.hostname, port);
  if (!ctx.alive()) {
    req.socket.destroy();
    return;
  }
  if ("reason" in decision) return refuse(decision.reason, decision.host, port);
  if (ctx.upstreamFull()) return refuse("limit", decision.host, port);
  ctx.record("http", port, decision);
  let upstream: Socket;
  try {
    upstream = await ctx.connectUpstream(decision.ips, port);
  } catch {
    if (!res.destroyed) res.writeHead(502, { connection: "close" }).end();
    return;
  }
  if (!ctx.alive()) {
    upstream.destroy();
    req.socket.destroy();
    return;
  }
  const out = httpRequest({
    // No agent: Node then uses this connection and no other.
    createConnection: () => upstream,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: forwarded(req.headers, { host: target.host, connection: "close" }),
    setHost: false,
  });
  out.on("response", (answer) => {
    res.writeHead(answer.statusCode ?? 502, forwarded(answer.headers, { connection: "close" }));
    answer.on("data", (chunk: Buffer) => ctx.touch("down", chunk.length));
    answer.pipe(res);
  });
  out.on("error", () => {
    if (res.destroyed) return;
    if (!res.headersSent) res.writeHead(502, { connection: "close" });
    res.end();
  });
  req.on("data", (chunk: Buffer) => ctx.touch("up", chunk.length));
  req.pipe(out);
}
