import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type NameProxy, startNameProxy } from "./name-proxy.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function origin(): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "x-seen-host": req.headers.host ?? "",
      "x-proxy-header": req.headers["proxy-connection"] ?? "",
    });
    res.end(`path ${req.url ?? ""}`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  server.on("connection", (socket) => closers.push(async () => void socket.destroy()));
  return { port: (server.address() as AddressInfo).port, server };
}

async function proxy(): Promise<NameProxy> {
  const started = await startNameProxy({ "pap.test": "127.0.0.1" });
  closers.push(started.close);
  return started;
}

const viaProxy = (
  proxyUrl: string,
  target: string,
): Promise<{ status: number; body: string; host: string }> =>
  new Promise((resolve, reject) => {
    const at = new URL(proxyUrl);
    const req = request(
      {
        host: at.hostname,
        port: at.port,
        method: "GET",
        path: target,
        headers: { host: new URL(target).host, "proxy-connection": "keep-alive" },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, host: String(res.headers["x-seen-host"] ?? "") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

const connectVia = (proxyUrl: string, target: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const at = new URL(proxyUrl);
    const socket = connect(Number(at.port), at.hostname, () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("\r\n\r\n") && text.startsWith("HTTP/1.1 200"))
        socket.write(`GET /tunnel HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });

describe("name proxy", () => {
  it("serves pap.test from loopback, absolute-form, without the proxy headers", async () => {
    const { port } = await origin();
    const p = await proxy();
    const answer = await viaProxy(p.url, `http://pap.test:${port}/a?b=1`);
    expect(answer).toEqual({ status: 200, body: "path /a?b=1", host: `pap.test:${port}` });
    expect(p.served).toEqual([`pap.test:${port}`]);
    expect(p.refused).toEqual([]);
    expect(p.requests).toHaveLength(1);
    expect(p.requests[0]).toMatchObject({
      host: `pap.test:${port}`,
      method: "GET",
      path: "/a?b=1",
      status: 200,
    });
    expect(p.requests[0]?.headers["proxy-connection"]).toBeUndefined();
  });

  it("tunnels a CONNECT to pap.test and to nothing else", async () => {
    const { port } = await origin();
    const p = await proxy();
    const text = await connectVia(p.url, `pap.test:${port}`);
    expect(text).toContain("HTTP/1.1 200 Connection Established");
    expect(text).toContain("path /tunnel");
    expect(p.requests).toMatchObject([
      { host: `pap.test:${port}`, method: "GET", path: "/tunnel", status: 200 },
    ]);
    expect(await connectVia(p.url, "example.invalid:443")).toContain("403");
    expect(p.refused).toEqual(["example.invalid:443"]);
  });

  it("refuses every other host, an address and a relative request", async () => {
    const { port } = await origin();
    const p = await proxy();
    expect((await viaProxy(p.url, "http://example.invalid/")).status).toBe(403);
    expect((await viaProxy(p.url, `http://127.0.0.1:${port}/`)).status).toBe(403);
    expect((await viaProxy(p.url, "http://192.0.2.1/")).status).toBe(403);
    expect(p.refused).toEqual(["example.invalid", `127.0.0.1:${port}`, "192.0.2.1"]);
    expect(p.served).toEqual([]);
  });

  it("maps to loopback only", async () => {
    await expect(startNameProxy({ "pap.test": "192.168.1.5" })).rejects.toThrow(/loopback only/);
    await expect(startNameProxy({ "pap.test": "0.0.0.0" })).rejects.toThrow(/loopback only/);
  });
});
