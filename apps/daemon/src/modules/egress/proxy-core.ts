import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { EGRESS_LIMITS, type EgressHost, type EgressReason } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import { BAD_GATEWAY, BAD_HEAD, HEAD_TOO_LARGE, rawRefusal, UNREADABLE_HOST } from "./refusal.ts";
import { relayHttp } from "./relay-http.ts";
import { type CommandReport, createReport } from "./report.ts";

/** Why a VM's request was refused for its host list or address (sub-project 2, spec §3); the VM judge sets it. */
export interface VmDetail {
  readonly reason: "not_listed" | "private_wildcard" | "blocked_address";
  readonly address: string | null;
}

export type Decision =
  | { readonly ips: readonly string[]; readonly host: string }
  | {
      readonly reason: EgressReason;
      readonly host: string;
      /** The one-line body of the refusal, when the default sentence of `reason` is not the whole story. */
      readonly message?: string;
      /** 502 for a failure that is not a refusal (a listed name that does not resolve); the default status follows `reason`. */
      readonly status?: 502;
      readonly vm?: VmDetail;
    };

export type Limits = Record<keyof typeof EGRESS_LIMITS, number>;

/** What the cores of one proxy share: the clock, the limits and the way out. */
export interface CoresDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  connect(ip: string, port: number): Socket;
  readonly limits: Limits;
}

/** One command's (host mode) or one VM agent's (VM mode) share of a proxy: its connections, report and judge. */
export interface CoreOptions {
  /** Names the owner of the connections in the `egress_limit` line. */
  readonly scope: { readonly agentId: string; readonly sessionId: string | null };
  decide(kind: EgressHost["kind"], rawHost: string, port: number): Promise<Decision>;
}

interface Conn {
  readonly client: Socket;
  /** Every upstream this connection opened; `end` destroys them all. */
  readonly upstreams: Set<Socket>;
  /** One request or CONNECT per client connection: set by the first, a second destroys the socket. */
  used: boolean;
  head: TimerHandle | null;
  idle: TimerHandle | null;
  life: TimerHandle | null;
}

const LIMIT_LOG_EVERY_MS = 60_000;

/** Writes the last words and closes: a client that never reads or closes cannot keep the descriptor. */
export const sendAndClose = (socket: Duplex, text: string): void => {
  if (socket.writable) socket.end(text, () => socket.destroy());
  else socket.destroy();
};

/**
 * The CONNECT and plain-HTTP handling both listeners share. The upstream slots and the limit log are counted across every
 * core of the proxy; the connections, the report and the byte total belong to one core.
 */
export function createCores(deps: CoresDeps) {
  const { clock, logger, limits } = deps;
  let upstreamOpen = 0;
  let limitLoggedAt = Number.NEGATIVE_INFINITY;

  const arm = (name: string, ms: number, work: () => void): TimerHandle =>
    clock.setTimeout(() => void guardTimer(logger, name, work, clock), ms);
  const disarm = (handle: TimerHandle | null): void => {
    if (handle) clock.clearTimeout(handle);
  };

  function create(options: CoreOptions) {
    const { scope } = options;
    let report = createReport(limits.hosts);
    const conns = new Map<Socket, Conn>();
    let closed = false;
    const limitHit = (what: string): void => {
      const now = clock.now();
      if (now - limitLoggedAt < LIMIT_LOG_EVERY_MS) return;
      limitLoggedAt = now;
      logger.warn("egress_limit", { what, agentId: scope.agentId, sessionId: scope.sessionId });
    };

    const end = (conn: Conn): void => {
      for (const timer of [conn.head, conn.idle, conn.life]) disarm(timer);
      conn.head = conn.idle = conn.life = null;
      conns.delete(conn.client);
      conn.client.destroy();
      for (const upstream of conn.upstreams) upstream.destroy();
      conn.upstreams.clear();
    };
    const touch = (conn: Conn, direction: "up" | "down", bytes: number): void => {
      report.count(direction, bytes);
      if (!conns.has(conn.client)) return;
      if (report.total() > limits.bytes) {
        limitHit("bytes");
        end(conn);
        return;
      }
      disarm(conn.idle);
      conn.idle = arm("egress_idle", limits.idleMs, () => end(conn));
    };
    const record = (kind: EgressHost["kind"], port: number, d: Decision): void => {
      const reason = "reason" in d ? d.reason : undefined;
      report.add({
        host: d.host,
        port,
        kind,
        verdict: reason ? "refused" : "allowed",
        ...(reason ? { reason } : {}),
      });
    };
    /** Reserves one upstream slot and connects to one checked address, 10 s at most. May throw: the connector's error. */
    const connectUpstream = (conn: Conn, ip: string, port: number): Socket => {
      const up = deps.connect(ip, port);
      upstreamOpen += 1;
      up.once("close", () => {
        upstreamOpen -= 1;
      });
      up.on("error", () => {}); // `close` follows an error; the caller answers 502 from it
      conn.upstreams.add(up);
      up.once("close", () => conn.upstreams.delete(up));
      const timer = up.connecting ? arm("egress_connect", limits.connectMs, () => up.destroy()) : null;
      up.once("connect", () => disarm(timer));
      up.once("close", () => disarm(timer));
      return up;
    };
    /** Settles when the socket is connected (true) or has closed without it (false). */
    const connected = (up: Socket): Promise<boolean> =>
      up.connecting
        ? new Promise((resolve) => {
            up.once("connect", () => resolve(true));
            up.once("close", () => resolve(false));
          })
        : Promise.resolve(!up.destroyed);
    /** Tries the checked answers in order and keeps the first that connects. Throws when none does, or the command is gone. */
    const connectAny = async (conn: Conn, ips: readonly string[], port: number): Promise<Socket> => {
      for (const [attempt, ip] of ips.entries()) {
        // The command may be gone, and the room for upstreams may have gone to another command since the last attempt.
        if (closed || !conns.has(conn.client) || (attempt > 0 && upstreamFull())) break;
        try {
          const up = connectUpstream(conn, ip, port);
          if (await connected(up)) return up;
        } catch {
          // the connector refused this address: the next answer gets its turn
        }
      }
      throw new Error("no address could be reached");
    };
    const upstreamFull = (): boolean => {
      if (upstreamOpen < limits.upstream) return false;
      limitHit("upstream");
      return true;
    };
    const guarded = (socket: Socket, work: () => Promise<void> | void): void => {
      Promise.resolve()
        .then(work)
        .catch((error: unknown) => {
          logger.warn("egress_handler_failed", { name: error instanceof Error ? error.name : "unknown" });
          socket.destroy();
        });
    };

    /** A new client connection: tracked under its timers, or refused when the core is closed or full. */
    const accept = (socket: Socket): void => {
      socket.on("error", () => {}); // `close` follows an error and ends the connection
      if (closed) {
        socket.destroy();
        return;
      }
      if (conns.size >= limits.connections || report.total() >= limits.bytes) {
        limitHit(conns.size >= limits.connections ? "connections" : "bytes");
        sendAndClose(socket, rawRefusal("limit"));
        return;
      }
      const conn: Conn = {
        client: socket,
        upstreams: new Set(),
        used: false,
        head: null,
        idle: null,
        life: null,
      };
      conns.set(socket, conn);
      conn.head = arm("egress_head", limits.headMs, () => end(conn));
      conn.idle = arm("egress_idle", limits.idleMs, () => end(conn));
      conn.life = arm("egress_life", limits.connectionMs, () => end(conn));
      socket.on("close", () => end(conn));
    };

    const clientError = (error: NodeJS.ErrnoException, socket: Duplex): void => {
      sendAndClose(socket, error.code === "HPE_HEADER_OVERFLOW" ? HEAD_TOO_LARGE : BAD_HEAD);
    };

    /** The head is read: from here the connection is judged by `decide`, and may be gone by the time it answers. */
    const begin = (socket: Socket): Conn | null => {
      const conn = conns.get(socket);
      if (conn === undefined || closed || conn.used) {
        socket.destroy();
        return null;
      }
      conn.used = true;
      disarm(conn.head);
      conn.head = null;
      return conn;
    };

    async function onConnect(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
      const conn = begin(socket);
      if (conn === null) return;
      const match = /^(\[[^\]]*\]|[^:[\]]*):(\d{1,5})$/.exec(req.url ?? "");
      const port = Number(match?.[2] ?? 0);
      const decision: Decision = match
        ? await options.decide("connect", match[1] ?? "", port)
        : { reason: "bad_target", host: UNREADABLE_HOST };
      if (closed || !conns.has(socket)) {
        socket.destroy();
        return;
      }
      if (!("reason" in decision) && upstreamFull()) {
        record("connect", port, { reason: "limit", host: decision.host });
        sendAndClose(socket, rawRefusal("limit"));
        return;
      }
      record("connect", port, decision);
      if ("reason" in decision) {
        sendAndClose(socket, rawRefusal(decision.reason, decision.message, decision.status));
        return;
      }
      let upstream: Socket;
      try {
        upstream = await connectAny(conn, decision.ips, port);
      } catch {
        sendAndClose(socket, BAD_GATEWAY);
        return;
      }
      if (closed || !conns.has(socket)) {
        upstream.destroy();
        socket.destroy();
        return;
      }
      let established = false;
      upstream.once("close", () => (established ? socket.destroy() : sendAndClose(socket, BAD_GATEWAY)));
      established = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.pipe(socket);
      socket.pipe(upstream);
      upstream.on("data", (chunk: Buffer) => touch(conn, "down", chunk.length));
      socket.on("data", (chunk: Buffer) => touch(conn, "up", chunk.length));
      if (head.length > 0) {
        upstream.write(head);
        touch(conn, "up", head.length);
      }
    }

    const request = (req: IncomingMessage, res: ServerResponse): void =>
      guarded(req.socket, () => {
        const conn = begin(req.socket);
        if (conn === null) return;
        return relayHttp(
          {
            decide: (kind, host, port) => options.decide(kind, host, port),
            alive: () => !closed && conns.has(req.socket),
            record: (kind, port, decision) => record(kind, port, decision),
            touch: (direction, bytes) => touch(conn, direction, bytes),
            upstreamFull,
            connectUpstream: (ips, port) => connectAny(conn, ips, port),
          },
          req,
          res,
        );
      });
    const connect = (req: IncomingMessage, socket: Socket, head: Buffer): void =>
      guarded(socket, () => onConnect(req, socket, head));

    return {
      accept,
      request,
      connect,
      clientError,
      /** Wires a server that serves this core alone. */
      attach(server: Server): void {
        server.on("connection", accept);
        server.on("clientError", clientError);
        server.on("request", request);
        server.on("connect", (req, socket: Socket, head: Buffer) => connect(req, socket, head));
      },
      connections: (): number => conns.size,
      /** Destroys every connection and refuses new ones. */
      close(): void {
        closed = true;
        for (const conn of [...conns.values()]) end(conn);
      },
      snapshot: (): CommandReport => report.snapshot(),
      counts: () => report.counts(),
      /** What was reached since the last call, and a fresh report: a long-lived core reports by window. */
      rotate() {
        const taken = { report: report.snapshot(), ...report.counts() };
        report = createReport(limits.hosts);
        return taken;
      },
    };
  }

  return { create };
}
export type ProxyCore = ReturnType<ReturnType<typeof createCores>["create"]>;
