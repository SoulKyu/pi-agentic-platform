import { chmodSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { EGRESS_LIMITS, type EgressHost } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import type { EgressScope } from "./allow.ts";
import { createJudge, type Decision } from "./judge.ts";
import { BAD_GATEWAY, BAD_HEAD, HEAD_TOO_LARGE, rawRefusal, UNREADABLE_HOST } from "./refusal.ts";
import { relayHttp } from "./relay-http.ts";
import { type CommandReport, createReport, loggedHosts } from "./report.ts";

export type Limits = Record<keyof typeof EGRESS_LIMITS, number>;

/**
 * Everything the proxy reaches the world through. `resolve`, `denies` and `connect` are required and have no default:
 * `index.ts` passes the system resolver, `blockedStrict` and `net.connect`; only tests pass anything else (M11R244).
 */
export interface ProxyDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  resolve(host: string): Promise<readonly string[]>;
  denies(ip: string): boolean;
  connect(ip: string, port: number): Socket;
  readonly limits?: Limits;
}

export interface CommandListener {
  readonly path: string;
  readonly server: Server;
  /** Stops accepting, destroys every connection, removes the socket, answers the report. Safe to call twice. */
  close(): Promise<CommandReport>;
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
export function createProxy(deps: ProxyDeps) {
  const { clock, logger } = deps;
  const limits: Limits = deps.limits ?? EGRESS_LIMITS;
  let upstreamOpen = 0;
  let limitLoggedAt = Number.NEGATIVE_INFINITY;

  const arm = (name: string, ms: number, work: () => void): TimerHandle =>
    clock.setTimeout(() => void guardTimer(logger, name, work, clock), ms);
  const disarm = (handle: TimerHandle | null): void => {
    if (handle) clock.clearTimeout(handle);
  };
  const limitHit = (what: string, scope: EgressScope): void => {
    const now = clock.now();
    if (now - limitLoggedAt < LIMIT_LOG_EVERY_MS) return;
    limitLoggedAt = now;
    logger.warn("egress_limit", { what, agentId: scope.agentId, sessionId: scope.sessionId });
  };
  /** Writes the last words and closes: a client that never reads or closes cannot keep the descriptor. */
  const sendAndClose = (socket: Duplex, text: string): void => {
    if (socket.writable) socket.end(text, () => socket.destroy());
    else socket.destroy();
  };
  const judge = createJudge({
    clock,
    logger,
    resolve: (host) => deps.resolve(host),
    denies: (ip) => deps.denies(ip),
    resolveMs: limits.resolveMs,
  });

  async function listen(path: string, scope: EgressScope): Promise<CommandListener> {
    const report = createReport(limits.hosts);
    const conns = new Map<Socket, Conn>();
    let closed = false;
    let finished: Promise<CommandReport> | null = null;
    const server = createServer({ maxHeaderSize: limits.headBytes, headersTimeout: 0, requestTimeout: 0 });
    const lane = {}; // names this command to the lookup semaphore

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
        limitHit("bytes", scope);
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
      limitHit("upstream", scope);
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

    server.on("connection", (socket) => {
      socket.on("error", () => {}); // `close` follows an error and ends the connection
      if (closed) {
        socket.destroy();
        return;
      }
      if (conns.size >= limits.connections || report.total() >= limits.bytes) {
        limitHit(conns.size >= limits.connections ? "connections" : "bytes", scope);
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
    });

    server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
      sendAndClose(socket, error.code === "HPE_HEADER_OVERFLOW" ? HEAD_TOO_LARGE : BAD_HEAD);
    });

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
        ? await judge.decide(scope, lane, "connect", match[1] ?? "", port)
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
        sendAndClose(socket, rawRefusal(decision.reason));
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
      const open = (): void => {
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
      };
      open();
    }

    server.on("request", (req, res) =>
      guarded(req.socket, () => {
        const conn = begin(req.socket);
        if (conn === null) return;
        return relayHttp(
          {
            decide: (kind, host, port) => judge.decide(scope, lane, kind, host, port),
            alive: () => !closed && conns.has(req.socket),
            record: (kind, port, decision) => record(kind, port, decision),
            touch: (direction, bytes) => touch(conn, direction, bytes),
            upstreamFull,
            connectUpstream: (ips, port) => connectAny(conn, ips, port),
          },
          req,
          res,
        );
      }),
    );
    server.on("connect", (req, socket: Socket, head: Buffer) =>
      guarded(socket, () => onConnect(req, socket, head)),
    );

    const close = (): Promise<CommandReport> =>
      (finished ??= (async () => {
        closed = true;
        for (const conn of [...conns.values()]) end(conn);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(path, { force: true });
        const snapshot = report.snapshot();
        const hosts = loggedHosts(snapshot, scope, limits.logHosts);
        logger.info("egress_command", {
          sessionId: scope.sessionId,
          agentId: scope.agentId,
          ...report.counts(),
          up: snapshot.up,
          down: snapshot.down,
          hosts,
        });
        return snapshot;
      })());

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      await close();
      throw error;
    }
    return { path, server, close };
  }

  return { listen };
}
