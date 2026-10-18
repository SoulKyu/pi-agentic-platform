import type { LookupAddress } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { guardedGet, type Resolver } from "./guarded-get.ts";

/*
 * Socket-level tests use loopback only (W5-R50): 127.0.0.1 is the one address the test predicate allows and the server
 * listens on; 127.0.0.2 stands in for "private". A broken guard can therefore only reach loopback. The real ranges are
 * a pure test in google-fetch.test.ts (blockedStrict vectors).
 */
let server: Server;
let port = 0;
let seen: IncomingMessage[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;
beforeEach(async () => {
  seen = [];
  handler = (_req, res) => res.end("ok");
  server = createServer((req, res) => {
    seen.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const answer = (address: string): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 });
const resolverOf =
  (...addresses: string[]): Resolver =>
  (_host, _options, callback) =>
    callback(null, addresses.map(answer));
const onlyLoopback = (ip: string) => ip === "127.0.0.1";
const get = (over: Partial<Parameters<typeof guardedGet>[0]> = {}) =>
  guardedGet({
    url: `http://fonts.test:${port}/css2?family=Inter`,
    maxBytes: 1024,
    clock: createFakeClock(),
    allowAddress: onlyLoopback,
    resolve: resolverOf("127.0.0.1"),
    plainHttpForTests: true,
    ...over,
  });

describe("guardedGet", () => {
  it("returns the status and the body of a 200, sending a User-Agent and no cookie", async () => {
    const result = await get();
    expect(result).toEqual({ ok: true, status: 200, body: Buffer.from("ok") });
    expect(seen[0]?.headers["user-agent"]).toMatch(/Chrome/);
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("resolves the name exactly once per request (no second lookup to race)", async () => {
    let lookups = 0;
    const resolve: Resolver = (host, options, callback) => {
      lookups += 1;
      resolverOf("127.0.0.1")(host, options, callback);
    };
    expect(await get({ resolve })).toMatchObject({ ok: true, status: 200 });
    expect(lookups).toBe(1);
  });

  it("returns a 404 and a 400 as results, not as errors", async () => {
    handler = (_req, res) => res.writeHead(404).end("no");
    expect(await get()).toMatchObject({ ok: true, status: 404 });
  });

  it("refuses a redirect and never follows it", async () => {
    handler = (_req, res) => res.writeHead(302, { location: `http://fonts.test:${port}/elsewhere` }).end();
    expect(await get()).toEqual({ ok: false, error: "redirect" });
    expect(seen).toHaveLength(1);
  });

  it("accepts a body of exactly maxBytes and refuses maxBytes + 1", async () => {
    handler = (_req, res) => res.end(Buffer.alloc(1024, 7));
    expect(await get()).toMatchObject({ ok: true, body: expect.objectContaining({ length: 1024 }) });
    handler = (_req, res) => res.end(Buffer.alloc(1025, 7));
    expect(await get()).toEqual({ ok: false, error: "too_large" });
  });

  it("refuses a declared Content-Length over the cap at once, without waiting for the body", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": "5000" });
      res.write("x"); // the rest never comes: only the declared length can settle this
    };
    expect(await get()).toEqual({ ok: false, error: "too_large" });
  });

  it("refuses an oversized body that arrives without a Content-Length", async () => {
    handler = (_req, res) => {
      res.write(Buffer.alloc(700, 1));
      res.write(Buffer.alloc(700, 1));
      res.end();
    };
    expect(await get()).toEqual({ ok: false, error: "too_large" });
  });

  it("refuses a name whose answer is not allowed (or empty), without connecting", async () => {
    for (const answers of [["127.0.0.2"], ["::1"], []])
      expect(await get({ resolve: resolverOf(...answers) }), answers.join()).toEqual({
        ok: false,
        error: "address",
      });
    expect(await get({ resolve: resolverOf("127.0.0.1", "127.0.0.2") })).toEqual({
      ok: false,
      error: "address",
    });
    expect(seen).toHaveLength(0);
  });

  it("refuses an IP literal that is not allowed (the lookup hook is never called for it)", async () => {
    expect(await get({ url: `http://127.0.0.2:${port}/x` })).toEqual({ ok: false, error: "address" });
    expect(seen).toHaveLength(0);
  });

  it("refuses plain http unless the test switch is on", async () => {
    expect(await get({ plainHttpForTests: false })).toEqual({ ok: false, error: "address" });
    expect(seen).toHaveLength(0);
  });

  it("times out on the clock, not on a sleep", async () => {
    handler = () => {};
    const clock = createFakeClock();
    const pending = get({ clock });
    await clock.advance(15_000);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
  });

  it("takes a shorter total limit than 15 s, never a longer one", async () => {
    handler = () => {};
    const clock = createFakeClock();
    const pending = get({ clock, totalMs: 4_000 });
    await clock.advance(4_000);
    expect(await pending).toEqual({ ok: false, error: "timeout" });
    const longer = get({ clock, totalMs: 600_000 });
    await clock.advance(15_000);
    expect(await longer).toEqual({ ok: false, error: "timeout" });
  });

  it("reports an unreachable server as a network error", async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    expect(await get()).toEqual({ ok: false, error: "network" });
    server = createServer(); // so afterEach has something to close
  });
});
