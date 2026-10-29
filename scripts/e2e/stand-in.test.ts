import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bareCsp, SECURITY_HEADERS, startStandIn } from "./stand-in.ts";

const CSP = [
  "sandbox allow-scripts allow-forms allow-downloads",
  "default-src http://pap.test:41000 data: blob: 'unsafe-inline' 'unsafe-eval'",
  "connect-src http://pap.test:41000 ws://pap.test:41000 data: blob:",
  "frame-src http://pap.test:41000",
  "object-src 'none'",
  "frame-ancestors http://pap.test:40000",
].join("; ");
const LISTENER_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "access-control-allow-origin": "*",
};

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listener(status = 404, headers = LISTENER_HEADERS): Promise<string> {
  const server: Server = createServer((_req, res) =>
    res.writeHead(status, { ...headers, "content-length": "0" }).end(),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise<void>((done) => (server.closeAllConnections(), server.close(() => done()))));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("stand-in", () => {
  it("refuses a listener that does not answer its bare 404", async () => {
    await expect(
      startStandIn(0, "http://pap.test:41000", {
        listener: await listener(200),
        app: "http://pap.test:40000",
        canary: "/c.png",
        marker: "m",
        offLimits: "http://192.0.2.1/",
      }),
    ).rejects.toThrow(/expected 404/);
    const partial = Object.fromEntries(
      Object.entries(LISTENER_HEADERS).filter(([name]) => name !== "referrer-policy"),
    );
    await expect(
      startStandIn(0, "http://pap.test:41000", {
        listener: await listener(404, partial),
        app: "http://pap.test:40000",
        canary: "/c.png",
        marker: "m",
        offLimits: "http://192.0.2.1/",
      }),
    ).rejects.toThrow(/no referrer-policy/);
  });

  it("/headers copies exactly the security headers of the listener's 404", async () => {
    const started = await startStandIn(0, "http://pap.test:41000", {
      listener: await listener(),
      app: "http://pap.test:40000",
      canary: "/work/canary.png",
      marker: "UPLOAD-MARKER",
      offLimits: "http://192.0.2.1/",
    });
    closers.push(started.close);
    expect(started.headers).toEqual(LISTENER_HEADERS);
    expect(Object.keys(started.headers)).toEqual([...SECURITY_HEADERS]);
  });

  it("/bare holds the sandbox directive and frame-ancestors, nothing of the fetch directives", () => {
    const csp = bareCsp(CSP);
    expect(csp).toBe(
      "sandbox allow-scripts allow-forms allow-downloads; frame-ancestors http://pap.test:40000",
    );
    for (const name of ["default-src", "connect-src", "frame-src", "img-src", "form-action", "base-uri"])
      expect(csp).not.toContain(name);
    expect(() => bareCsp("default-src 'none'")).toThrow(/no sandbox directive/);
  });
});

// The served pages, read through a real socket (the stand-in listens on the port it was given).
describe("stand-in pages", () => {
  async function serve() {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
    const started = await startStandIn(port, `http://pap.test:${port}`, {
      listener: await listener(),
      app: "http://pap.test:40000",
      canary: "/work/canary.png",
      marker: "UPLOAD-MARKER",
      offLimits: "http://192.0.2.1/",
    });
    closers.push(started.close);
    return port;
  }
  const get = (port: number, path: string) =>
    new Promise<{ headers: Record<string, string | string[] | undefined>; body: string; status: number }>(
      (resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
          res.on("end", () => resolve({ headers: res.headers, body, status: res.statusCode ?? 0 }));
        });
        req.on("error", reject);
        req.end();
      },
    );

  it("/headers answers with the listener's headers and the off-limits probe", async () => {
    const port = await serve();
    const answer = await get(port, "/headers");
    for (const name of SECURITY_HEADERS) expect(answer.headers[name]).toBe(LISTENER_HEADERS[name]);
    expect(answer.body).toContain("http://192.0.2.1/");
    expect(answer.body).toContain("/files/raw?path=%2Fwork%2Fcanary.png");
    expect(answer.body).toContain("ws://pap.test:40000/ws?proto=2");
  });

  it("/bare carries only the sandbox and frame-ancestors, and no off-limits probe", async () => {
    const port = await serve();
    const answer = await get(port, "/bare");
    expect(answer.headers["content-security-policy"]).toBe(bareCsp(CSP));
    for (const name of SECURITY_HEADERS.filter((n) => n !== "content-security-policy"))
      expect(answer.headers[name]).toBeUndefined();
    expect(answer.body).not.toContain("192.0.2.1");
    expect((await get(port, "/other")).status).toBe(404);
  });
});
