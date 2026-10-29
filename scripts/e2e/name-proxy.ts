// A forward proxy for J20 (UX2-R87, decision 139): the browser reaches pap and the stand-in as `pap.test`, a name that is not
// potentially trustworthy, so it sends no Fetch Metadata (as to `http://192.168.1.182`), while every byte stays on loopback.
// It listens on 127.0.0.1 only, answers absolute-form requests, `CONNECT` (what browsers use for a WebSocket through a proxy)
// and absolute-form upgrades for the names it was given, mapped to a loopback address, and refuses any other host.
// Container-mode browsers (`--network host`) share the host's loopback, so they dial it as `http://127.0.0.1:<port>`.
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

/** An HTTP request the proxy forwarded, headers as the browser sent them (what pap received, minus `Proxy-*`). */
export interface ForwardedRequest {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** The status the target answered; null until it does (an upgrade is replayed raw: always null). */
  status: number | null;
  /** The headers of the answer (absolute-form requests only). */
  answerHeaders: IncomingHttpHeaders | null;
}

export interface NameProxy {
  /** `http://127.0.0.1:<port>`: the `proxy.server` of a browser context. */
  readonly url: string;
  /** `host:port` of every request or tunnel it refused, in order. */
  readonly refused: readonly string[];
  /** `host:port` of every one it served, in order. */
  readonly served: readonly string[];
  /** Every absolute-form request and upgrade it forwarded (a `CONNECT` tunnel is opaque to it). */
  readonly requests: readonly ForwardedRequest[];
  close(): Promise<void>;
}

const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|::1)$/;
const DEFAULT_PORT = 80;

/** `names` maps a host name to the loopback address it stands for; any other target is a programming error. */
export async function startNameProxy(names: Readonly<Record<string, string>>): Promise<NameProxy> {
  const targets = new Map<string, string>();
  for (const [name, address] of Object.entries(names)) {
    if (!LOOPBACK.test(address)) throw new Error(`the name proxy maps to loopback only, not ${address}`);
    targets.set(name.toLowerCase(), address);
  }
  const refused: string[] = [];
  const served: string[] = [];
  const requests: ForwardedRequest[] = [];
  const open = new Set<Socket>();

  const resolve = (
    hostPort: string,
    fallback: number,
  ): { host: string; port: number; label: string } | null => {
    const at = hostPort.lastIndexOf(":");
    const host = (at < 0 ? hostPort : hostPort.slice(0, at)).toLowerCase();
    const port = at < 0 ? fallback : Number(hostPort.slice(at + 1));
    const address = targets.get(host);
    if (address === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { host: address, port, label: `${host}:${port}` };
  };
  const track = (socket: Socket): void => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    socket.on("error", () => socket.destroy());
  };

  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      refused.push("relative");
      res.writeHead(400).end();
      return;
    }
    const target = url.protocol === "http:" ? resolve(url.host, DEFAULT_PORT) : null;
    if (target === null) {
      refused.push(url.host);
      res.writeHead(403).end();
      return;
    }
    served.push(target.label);
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([name]) => !name.startsWith("proxy-")),
    );
    const forwarded: ForwardedRequest = {
      host: target.label,
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      status: null,
      answerHeaders: null,
    };
    requests.push(forwarded);
    const upstream = request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
      },
      (answer) => {
        forwarded.status = answer.statusCode ?? null;
        forwarded.answerHeaders = answer.headers;
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(upstream);
  });

  const sniff = (client: Socket, upstream: Socket, host: string): void => {
    client.once("data", (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      const line = /^([A-Z]+) (\S+) HTTP\/1\.1\r\n/.exec(text);
      if (line === null) return;
      const headers: IncomingHttpHeaders = {};
      for (const row of text.slice(line[0].length, text.indexOf("\r\n\r\n")).split("\r\n")) {
        const colon = row.indexOf(":");
        if (colon > 0) headers[row.slice(0, colon).toLowerCase()] = row.slice(colon + 1).trim();
      }
      const forwarded: ForwardedRequest = {
        host,
        method: line[1] ?? "",
        path: line[2] ?? "",
        headers,
        status: null,
        answerHeaders: null,
      };
      requests.push(forwarded);
      upstream.once("data", (answer: Buffer) => {
        forwarded.status = Number(/^HTTP\/1\.\d (\d{3})/.exec(answer.toString("latin1"))?.[1] ?? 0) || null;
      });
    });
  };
  const tunnel = (
    client: Socket,
    head: Buffer,
    target: { host: string; port: number },
    greeting: string | null,
    label: string,
  ) => {
    const upstream = connect(target.port, target.host, () => {
      if (greeting !== null) client.write(greeting);
      // A WebSocket handshake through a tunnel is plain HTTP: read its request line, headers and the answer's status.
      if (greeting !== null) sniff(client, upstream, label);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.once("close", () => client.destroy());
    client.once("close", () => upstream.destroy());
  };
  server.on("connection", track);
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = resolve(req.url ?? "", 443);
    if (target === null) {
      refused.push(req.url ?? "");
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    served.push(target.label);
    tunnel(client, head, target, "HTTP/1.1 200 Connection Established\r\n\r\n", target.label);
  });
  server.on("upgrade", (req: IncomingMessage, client: Socket, head: Buffer) => {
    let url: URL | null = null;
    try {
      url = new URL(req.url ?? "");
    } catch {
      // a relative target is refused below
    }
    const target = url !== null && url.protocol === "http:" ? resolve(url.host, DEFAULT_PORT) : null;
    if (url === null || target === null) {
      refused.push(url?.host ?? "relative");
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    served.push(target.label);
    requests.push({
      host: target.label,
      method: req.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: req.headers,
      status: null,
      answerHeaders: null,
    });
    const lines = [`${req.method ?? "GET"} ${url.pathname}${url.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? "";
      if (!name.toLowerCase().startsWith("proxy-")) lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ""}`);
    }
    tunnel(
      client,
      Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), head]),
      target,
      null,
      target.label,
    );
  });

  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      done();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    refused,
    served,
    requests,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of open) socket.destroy();
        server.close(() => done());
      }),
  };
}
