import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { LookupAddress } from "node:dns";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { selfSignedCertificate } from "../../testing/self-signed.ts";
import { fetchFeed, type FeedFetchDeps } from "./feed-fetch.ts";
import { isPublicAddress, type Resolver } from "./net-guard.ts";

const RSS = `<rss version="2.0"><channel><item><title>Hello</title><link>https://example.com/hello</link></item></channel></rss>`;

let dir: string;
let cert: { cert: Buffer; key: Buffer };
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-feed-fetch-"));
  const files = selfSignedCertificate(dir);
  cert = { cert: readFileSync(files.cert), key: readFileSync(files.key) };
  return () => rmSync(dir, { recursive: true, force: true });
});

/** The names the tests use: `localhost` is the certificate's name and maps to the loopback; `private.test` to 10.0.0.5. */
const NAMES: Record<string, string> = {
  localhost: "127.0.0.1",
  "private.test": "10.0.0.5",
  "mixed.test": "127.0.0.1",
};
const resolve: Resolver = (name, _options, callback) => {
  const address = NAMES[name];
  if (name === "mixed.test") {
    callback(null, [
      { address: "127.0.0.1", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    return;
  }
  if (address === undefined)
    return callback(Object.assign(new Error("no such name"), { code: "ENOTFOUND" }), []);
  callback(null, [{ address, family: 4 } satisfies LookupAddress]);
};
/** The test-only seam: the loopback is allowed on top of production's rules (never passed in production). */
const loopbackToo = (address: string): boolean => address === "127.0.0.1" || isPublicAddress(address);

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
interface Fixture {
  readonly url: (path?: string, host?: string) => string;
  readonly requests: IncomingMessage[];
  readonly sockets: Set<Socket>;
  connections(): number;
  close(): Promise<void>;
}

const open: Server[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

async function serve(handler: Handler): Promise<Fixture> {
  const requests: IncomingMessage[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer(cert, (req, res) => {
    requests.push(req);
    handler(req, res);
  });
  server.on("connection", (socket: Socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  open.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: (path = "/feed.xml", host = "localhost") => `https://${host}:${port}${path}`,
    requests,
    sockets,
    connections: () => connections,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const rss: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" });
  res.end(RSS);
};

function deps(overrides: Partial<Omit<FeedFetchDeps, "clock">> = {}) {
  const clock = createFakeClock();
  return { resolve, allowed: loopbackToo, ca: cert.cert, ...overrides, clock };
}

describe("fetchFeed (M10R74, M10R77)", () => {
  it("fetches an RSS body over verified TLS and says where it ended", async () => {
    const server = await serve(rss);
    const result = await fetchFeed(server.url(), deps());
    expect(result).toEqual({ ok: true, body: RSS, finalUrl: server.url() });
  });

  it("sends a fixed identity: pap-feed, no encoding, no cookie, no credentials", async () => {
    const server = await serve(rss);
    await fetchFeed(server.url(), deps());
    const [req] = server.requests;
    expect(req?.headers["user-agent"]).toBe("pap-feed");
    expect(req?.headers["accept-encoding"]).toBe("identity");
    expect(req?.headers.cookie).toBeUndefined();
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.method).toBe("GET");
  });

  it("follows five redirects", async () => {
    const server = await serve((req, res) => {
      const step = Number(/\/r\/(\d+)/.exec(req.url ?? "")?.[1] ?? -1);
      if (step < 0) return rss(req, res);
      if (step === 4) {
        res.writeHead(302, { location: "/feed.xml" });
        return res.end();
      }
      res.writeHead([301, 302, 303, 307, 308][step % 5] as number, { location: `/r/${step + 1}` });
      res.end();
    });
    const result = await fetchFeed(server.url("/r/0"), deps());
    expect(result).toMatchObject({ ok: true, body: RSS, finalUrl: server.url("/feed.xml") });
  });

  it("refuses a sixth redirect", async () => {
    const server = await serve((req, res) => {
      const step = Number(/\/r\/(\d+)/.exec(req.url ?? "")?.[1] ?? 0);
      res.writeHead(302, { location: `/r/${step + 1}` });
      res.end();
    });
    const result = await fetchFeed(server.url("/r/0"), deps());
    expect(result).toEqual({ ok: false, code: "feed_redirects", retry: false });
    expect(server.requests).toHaveLength(6);
  });

  it("refuses a redirect to http: without a second request", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(302, { location: "http://localhost/feed.xml" });
      res.end();
    });
    const result = await fetchFeed(server.url(), deps());
    expect(result).toEqual({ ok: false, code: "feed_address", retry: false });
    expect(server.requests).toHaveLength(1);
  });

  it("refuses a redirect to a literal private address without connecting", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(302, { location: "https://10.0.0.5:9/feed.xml" });
      res.end();
    });
    const result = await fetchFeed(server.url(), deps());
    expect(result).toEqual({ ok: false, code: "feed_address", retry: false });
    expect(server.connections()).toBe(1);
  });

  it("refuses a redirect to a name that resolves to a private address, with production's allowed", async () => {
    let target = "";
    const server = await serve((_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    target = server.url("/feed.xml", "private.test");
    const result = await fetchFeed(
      server.url(),
      deps({ allowed: (address) => address === "127.0.0.1" || isPublicAddress(address) }),
    );
    expect(result).toEqual({ ok: false, code: "feed_address", retry: false });
    expect(server.connections()).toBe(1);
  });

  it("refuses a name whose answers hold one non-public address, before any connection", async () => {
    const server = await serve(rss);
    const result = await fetchFeed(server.url("/feed.xml", "mixed.test"), deps());
    expect(result).toEqual({ ok: false, code: "feed_address", retry: false });
    expect(server.connections()).toBe(0);
  });

  it("refuses a literal loopback address when production's rule applies", async () => {
    const server = await serve(rss);
    const result = await fetchFeed(server.url("/feed.xml", "127.0.0.1"), {
      clock: createFakeClock(),
      resolve,
      ca: cert.cert,
    });
    expect(result).toEqual({ ok: false, code: "feed_address", retry: false });
    expect(server.connections()).toBe(0);
  });

  it("refuses the name `localhost` when production's rule applies", async () => {
    const server = await serve(rss);
    const result = await fetchFeed(server.url(), { clock: createFakeClock(), resolve, ca: cert.cert });
    expect(result).toEqual({ ok: false, code: "feed_address", retry: false });
    expect(server.connections()).toBe(0);
  });

  it("refuses http: and credentials before anything else", async () => {
    const server = await serve(rss);
    expect(await fetchFeed(server.url().replace("https:", "http:"), deps())).toMatchObject({
      ok: false,
      code: "feed_address",
    });
    expect(await fetchFeed(server.url().replace("//", "//user:pw@"), deps())).toMatchObject({
      ok: false,
      code: "feed_address",
    });
    expect(await fetchFeed("not a url", deps())).toMatchObject({ ok: false, code: "feed_address" });
    expect(server.connections()).toBe(0);
  });

  it("stops a 2 MiB body that streams, and closes the connection", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const push = () => {
        while (sent < 2 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", push);
        }
        res.end();
      };
      push();
    });
    const result = await fetchFeed(server.url(), deps());
    expect(result).toEqual({ ok: false, code: "feed_too_large", retry: false });
    await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 5000 });
  });

  it("refuses at once a body whose declared length is over the cap", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/xml", "content-length": String(2 * 1024 * 1024) });
      res.write("<rss>");
    });
    const result = await fetchFeed(server.url(), deps());
    expect(result).toEqual({ ok: false, code: "feed_too_large", retry: false });
    await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 5000 });
  });

  it("accepts a body of exactly 1 MiB and refuses one byte more", async () => {
    const pad = (size: number) => `<rss>${"a".repeat(size - 11)}</rss>`;
    const server = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(pad(req.url === "/over" ? 1024 * 1024 + 1 : 1024 * 1024));
    });
    expect(await fetchFeed(server.url("/at"), deps())).toMatchObject({ ok: true });
    expect(await fetchFeed(server.url("/over"), deps())).toMatchObject({ ok: false, code: "feed_too_large" });
  });

  it("times out at 10 s on the clock when the server never answers, and destroys the socket", async () => {
    const server = await serve(() => {});
    const d = deps();
    const pending = fetchFeed(server.url(), d);
    await vi.waitFor(() => expect(server.requests).toHaveLength(1), { timeout: 5000 });
    await d.clock.advance(9_999);
    expect(server.sockets.size).toBe(1);
    await d.clock.advance(1);
    expect(await pending).toEqual({ ok: false, code: "feed_timeout", retry: true });
    await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 5000 });
    expect(d.clock.pending()).toBe(0);
  });

  it("times out on a body that trickles", async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.write("<rss>");
    });
    const d = deps();
    const pending = fetchFeed(server.url(), d);
    await vi.waitFor(() => expect(server.requests).toHaveLength(1), { timeout: 5000 });
    await d.clock.advance(10_000);
    expect(await pending).toEqual({ ok: false, code: "feed_timeout", retry: true });
  });

  it("answers feed_timeout, retry true, when the signal aborts at 2 s, and destroys the socket", async () => {
    const server = await serve(() => {});
    const controller = new AbortController();
    const d = deps({ signal: controller.signal });
    const pending = fetchFeed(server.url(), d);
    await vi.waitFor(() => expect(server.requests).toHaveLength(1), { timeout: 5000 });
    await d.clock.advance(2_000);
    controller.abort();
    expect(await pending).toEqual({ ok: false, code: "feed_timeout", retry: true });
    await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 5000 });
    expect(d.clock.pending()).toBe(0);
  });

  it("does not connect when the signal is already aborted", async () => {
    const server = await serve(rss);
    const result = await fetchFeed(server.url(), deps({ signal: AbortSignal.abort() }));
    expect(result).toEqual({ ok: false, code: "feed_timeout", retry: true });
    expect(server.connections()).toBe(0);
  });

  it("maps statuses: a client error fails, a server error and 429 retry", async () => {
    const server = await serve((req, res) => {
      res.writeHead(Number(req.url?.slice(1)));
      res.end();
    });
    expect(await fetchFeed(server.url("/404"), deps())).toEqual({
      ok: false,
      code: "feed_status_404",
      retry: false,
    });
    expect(await fetchFeed(server.url("/503"), deps())).toEqual({
      ok: false,
      code: "feed_status_503",
      retry: true,
    });
    expect(await fetchFeed(server.url("/429"), deps())).toEqual({
      ok: false,
      code: "feed_status_429",
      retry: true,
    });
    expect(await fetchFeed(server.url("/304"), deps())).toEqual({
      ok: false,
      code: "feed_status_304",
      retry: false,
    });
  });

  it("refuses a certificate it cannot verify", async () => {
    const server = await serve(rss);
    const result = await fetchFeed(server.url(), { clock: createFakeClock(), resolve, allowed: loopbackToo });
    expect(result).toEqual({ ok: false, code: "feed_tls", retry: false });
  });

  it("retries a connection that cannot be made", async () => {
    const server = await serve(rss);
    const url = server.url();
    await server.close();
    const result = await fetchFeed(url, deps());
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it("retries a name that does not resolve", async () => {
    const result = await fetchFeed("https://nowhere.test/feed", deps());
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it("refuses a page that is not a feed by its content type or encoding", async () => {
    const server = await serve((req, res) => {
      if (req.url === "/gzip")
        res.writeHead(200, { "content-type": "application/xml", "content-encoding": "gzip" });
      else res.writeHead(200, { "content-type": req.url === "/html" ? "text/html" : "application/json" });
      res.end(RSS);
    });
    for (const path of ["/html", "/json", "/gzip"])
      expect(await fetchFeed(server.url(path), deps()), path).toEqual({
        ok: false,
        code: "not_a_feed",
        retry: false,
      });
  });

  it("accepts a missing content type and the usual feed types", async () => {
    const types = [
      "application/atom+xml",
      "application/rdf+xml",
      "text/plain; charset=utf-8",
      "application/octet-stream",
    ];
    const server = await serve((req, res) => {
      const type = types[Number(req.url?.slice(1))];
      res.writeHead(200, type === undefined ? {} : { "content-type": type });
      res.end(RSS);
    });
    for (const index of [0, 1, 2, 3, 9])
      expect(await fetchFeed(server.url(`/${index}`), deps()), String(index)).toMatchObject({ ok: true });
  });

  it("reads a body that arrives in pieces, including a multi-byte character cut in two", async () => {
    const full = Buffer.from(`<rss><channel><item><title>café</title></item></channel></rss>`);
    const cut = full.indexOf(0xc3) + 1;
    const server = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      res.write(full.subarray(0, cut));
      setImmediate(() => res.end(full.subarray(cut)));
    });
    const result = await fetchFeed(server.url(), deps());
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.body).toContain("café");
  });
});
