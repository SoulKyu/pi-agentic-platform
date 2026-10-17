import { createServer as createHttp, type IncomingMessage } from "node:http";
import { createServer, connect, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import { createProxy, type CommandListener, type EgressScope, type ProxyDeps } from "../index.ts";
import { loopbackBed, type LoopbackBed } from "./loopback.ts";

/** TEST ONLY: a proxy over local origins, a fake clock and a capturing logger. Imported by `*.test.ts` files. */
export interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface Bed {
  readonly dir: string;
  readonly clock: FakeClock;
  readonly lines: Array<Record<string, unknown>>;
  readonly seen: SeenRequest[];
  readonly calls: { resolve: string[]; connect: Array<{ ip: string; port: number }> };
  readonly listeners: CommandListener[];
  /** How many connections the plain HTTP origin holds open right now. */
  originOpen(): Promise<number>;
  listen(scope?: EgressScope, name?: string): Promise<CommandListener>;
  stop(): Promise<void>;
}

export const scopeOf = (over: Partial<EgressScope> = {}, grants: readonly string[] = []): EgressScope => ({
  ownerId: "u1",
  agentId: "atlas-1a2b",
  sessionId: "s1",
  hosts: ["allowed.test", "allowed2.test"],
  trustedSources: [],
  grants: () => grants,
  ...over,
});

const listening = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );

export interface BedOptions {
  resolve?: ProxyDeps["resolve"];
  denies?: ProxyDeps["denies"];
  limits?: ProxyDeps["limits"];
  /** Replaces the loopback connector (after the call is recorded): a test holds an attempt open or makes it fail by hand. */
  connect?: ProxyDeps["connect"];
  /** The origin reads the request and never answers. */
  hang?: boolean;
  /** Replies the plain HTTP origin gives (default: 200 `origin ok`). */
  reply?: (req: SeenRequest) => { status: number; headers?: Record<string, string>; body: string };
}

export async function startBed(options: BedOptions = {}): Promise<Bed> {
  const dir = mkdtempSync(join(tmpdir(), "pxy-"));
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const seen: SeenRequest[] = [];
  const sockets = new Set<Socket>();
  const origin = createHttp((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      seen.push(request);
      if (options.hang) return;
      const reply = options.reply?.(request) ?? { status: 200, body: "origin ok" };
      res.writeHead(reply.status, reply.headers ?? {});
      res.end(reply.body);
    });
  });
  const echo = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  const originPort = await listening(origin);
  const echoPort = await listening(echo);
  // A port nobody listens on: a connection to it is refused, like an address that answers but does not accept.
  const dead = createServer();
  const deadPort = await listening(dead);
  await new Promise((resolve) => dead.close(resolve));
  const loop: LoopbackBed = loopbackBed({
    "allowed.test": { 80: originPort, 443: echoPort },
    "allowed2.test": { 80: originPort, 443: echoPort },
    "dead.test": { 80: deadPort, 443: deadPort },
  });
  const calls: Bed["calls"] = { resolve: [], connect: [] };
  const proxy = createProxy({
    clock,
    logger,
    resolve: (host) => {
      calls.resolve.push(host);
      return (options.resolve ?? loop.resolve)(host);
    },
    denies: options.denies ?? loop.denies,
    connect: (ip, port) => {
      calls.connect.push({ ip, port });
      return (options.connect ?? loop.connect)(ip, port);
    },
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const listeners: CommandListener[] = [];
  let count = 0;
  return {
    dir,
    clock,
    lines,
    seen,
    calls,
    listeners,
    originOpen: () => new Promise((resolve) => origin.getConnections((_error, count) => resolve(count))),
    async listen(scope = scopeOf(), name = `${count++}.s`) {
      const listener = await proxy.listen(join(dir, name), scope);
      listeners.push(listener);
      return listener;
    },
    async stop() {
      for (const listener of listeners) await listener.close();
      for (const socket of sockets) socket.destroy();
      origin.closeAllConnections();
      await new Promise((resolve) => origin.close(resolve));
      await new Promise((resolve) => echo.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes `payload` to the unix socket and returns everything read until the proxy closes the connection. */
export function exchange(path: string, payload: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = connect(path);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    socket.write(payload);
  });
}

export const statusOf = (reply: string): string => reply.split("\r\n", 1)[0] ?? "";
export const denyOf = (reply: string): string | undefined => /^x-pap-deny: (.*)\r$/im.exec(reply)?.[1];
export const bodyOf = (reply: string): string => {
  const body = reply.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  if (!/^transfer-encoding: chunked\r$/im.test(reply)) return body;
  let decoded = "";
  for (let rest = body; ;) {
    const size = parseInt(rest.split("\r\n", 1)[0] ?? "0", 16);
    if (!size) return decoded;
    const start = rest.indexOf("\r\n") + 2;
    decoded += rest.slice(start, start + size);
    rest = rest.slice(start + size + 2);
  }
};

export const connectLine = (target: string): string =>
  `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
export const getLine = (url: string, extra = ""): string =>
  `GET ${url} HTTP/1.1\r\nHost: x\r\n${extra}Proxy-Connection: keep-alive\r\n\r\n`;

/** Opens a CONNECT tunnel; resolves once the head of the answer is read. */
export function tunnel(path: string, target: string): Promise<{ socket: Socket; head: string }> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Buffer): void => {
      head += chunk.toString();
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ socket, head });
    };
    socket.on("data", onData);
    socket.write(connectLine(target));
  });
}

export const nextData = (socket: Socket): Promise<string> =>
  new Promise((resolve) => socket.once("data", (chunk: Buffer) => resolve(chunk.toString())));
export const closed = (socket: Socket): Promise<void> =>
  new Promise((resolve) => (socket.destroyed ? resolve() : socket.once("close", () => resolve())));
