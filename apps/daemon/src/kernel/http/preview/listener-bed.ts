import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { type AddressInfo, connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { type Clock, createSystemClock } from "../../clock.ts";
import type { LogFields, Logger } from "../../logger.ts";
import { createPreviewListener, type ListenerGrant } from "./listener.ts";

export const SERVICE_TOKEN = "S".repeat(43);
export const ARTIFACT_TOKEN = "A".repeat(43);
export const APP_ORIGIN = "https://pap.test";

export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface Upstream {
  readonly port: number;
  readonly seen: SeenRequest[];
  /** Replaces the answer of the next requests: the default one is `200 ok`. */
  answer: (req: IncomingMessage, res: ServerResponse) => void;
  /** Replaces the WebSocket handshake: the default one is an echo server. */
  /** Answers as soon as the headers arrive, before the body is read. */
  early: boolean;
  upgrade: ((req: IncomingMessage, socket: Duplex) => void) | null;
  close(): Promise<void>;
}

/** A real HTTP and WebSocket service on an ephemeral port: the listener's upstream. */
export async function startUpstream(): Promise<Upstream> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    if (upstream.early) {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.alloc(0),
      });
      return upstream.answer(req, res);
    }
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      upstream.answer(req, res);
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.alloc(0) });
    if (upstream.upgrade !== null) return upstream.upgrade(req, socket);
    sockets.handleUpgrade(req, socket, head, (ws) =>
      ws.on("message", (data, binary) => ws.send(data, { binary })),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const upstream: Upstream = {
    port: (server.address() as AddressInfo).port,
    seen,
    answer: (_req, res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok"),
    early: false,
    upgrade: null,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        sockets.close();
        server.close(() => resolve());
      }),
  };
  return upstream;
}

export interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly fields: LogFields | undefined;
}

export function recordingLogger(): Logger & { readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (msg: string, fields?: LogFields) => void lines.push({ level, msg, fields });
  const logger: Logger & { readonly lines: LogLine[] } = {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  };
  return logger;
}

export const serviceGrant = (
  upstream: Upstream,
  extra: Partial<Extract<ListenerGrant, { kind: "service" }>> = {},
): ListenerGrant => ({
  kind: "service",
  box: "box-1",
  port: upstream.port,
  sources: [],
  open: () => Promise.resolve(connect(upstream.port, "127.0.0.1") as Duplex),
  ...extra,
});

export interface PreviewBed {
  readonly port: number;
  readonly origin: string;
  readonly logger: ReturnType<typeof recordingLogger>;
  close(): Promise<void>;
}

export async function startPreview(options: {
  readonly grants: Readonly<Record<string, ListenerGrant>>;
  readonly clock?: Clock;
  readonly onTraffic?: (box: string) => void;
  /** A token whose lookup throws. */
  readonly throwOn?: string;
}): Promise<PreviewBed> {
  const logger = recordingLogger();
  const listener = createPreviewListener({
    appOrigins: [APP_ORIGIN],
    previewOrigin: (port) => `http://127.0.0.1:${port}`,
    // Not filtered by kind: the listener's own guard must hold against a port that answers a token of the other kind.
    grantOf: (_kind, token) => {
      if (token === options.throwOn) throw new Error("grant store failed");
      return options.grants[token] ?? null;
    },
    ...(options.onTraffic === undefined ? {} : { onTraffic: options.onTraffic }),
    clock: options.clock ?? createSystemClock(),
    logger,
  });
  const { port } = await listener.listen("127.0.0.1", 0, null);
  return { port, origin: `http://127.0.0.1:${port}`, logger, close: () => listener.close() };
}

export interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** node:http sends the request line exactly as given (fetch normalises the target). */
export const send = (
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });

/** The request the service saw at `index`; the test fails here when there is none. */
export function seenAt(upstream: Upstream, index: number): SeenRequest {
  const seen = upstream.seen.at(index);
  if (seen === undefined) throw new Error(`the service saw no request at ${index}`);
  return seen;
}

/** Bytes written to a raw socket; the answer is what came back when the peer closed, or once `enough` accepts it. */
export const rawExchange = (
  port: number,
  text: string,
  enough: (reply: string) => boolean = () => false,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let reply = "";
    const finish = (): void => {
      resolve(reply);
      socket.destroy();
    };
    socket.on("data", (chunk: Buffer) => {
      reply += chunk.toString("latin1");
      if (enough(reply)) finish();
    });
    socket.on("close", finish);
    socket.on("error", reject);
  });

/** A client that writes `text` and then never ends its side (half-open allowed): resolves with the first reply bytes. */
export const holdOpen = (port: number, text: string): Promise<{ reply: string; socket: Socket }> =>
  new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true }, () => socket.write(text));
    socket.once("data", (chunk: Buffer) => resolve({ reply: chunk.toString("latin1"), socket }));
    socket.on("error", reject);
  });
