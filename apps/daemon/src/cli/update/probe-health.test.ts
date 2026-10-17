import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { probeHealth, probeHost } from "./probe-health.ts";

let scratch: string;
let key: string;
let cert: string;
const servers: Server[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-probe-"));
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
      ...["-keyout", join(scratch, "k.pem"), "-out", join(scratch, "c.pem"), "-days", "1"],
      ...["-subj", "/CN=public.example"],
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(scratch, "k.pem"), "utf8");
  cert = readFileSync(join(scratch, "c.pem"), "utf8");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

type Answer = { status?: number; body: string };
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
const reply =
  (answer: Answer) =>
  (_req: unknown, res: { writeHead(code: number): void; end(body: string): void }): void => {
    res.writeHead(answer.status ?? 200);
    res.end(answer.body);
  };
const OK: Answer = { body: '{"status":"ok"}' };
const http = (answer: Answer = OK) => listen(createHttp(reply(answer)));
const https = (answer: Answer = OK) => listen(createHttps({ key, cert }, reply(answer)));

describe("probeHealth", () => {
  it("an HTTP unit answering ok is healthy", async () => {
    expect(await probeHealth({ host: null, port: await http(), tls: false })).toBe(true);
  });

  it("an HTTPS unit whose certificate is for another name is healthy: the certificate is not verified (M6bR11c)", async () => {
    expect(await probeHealth({ host: null, port: await https(), tls: true })).toBe(true);
  });

  it("an HTTP probe of an HTTPS server is not healthy", async () => {
    expect(await probeHealth({ host: null, port: await https(), tls: false })).toBe(false);
  });

  it("an HTTPS probe of an HTTP server is not healthy", async () => {
    expect(await probeHealth({ host: null, port: await http(), tls: true })).toBe(false);
  });

  it('{"status":"no"}, a 500 with the right body and a non-JSON body are not healthy', async () => {
    expect(await probeHealth({ host: null, port: await http({ body: '{"status":"no"}' }), tls: false })).toBe(
      false,
    );
    expect(await probeHealth({ host: null, port: await http({ status: 500, ...OK }), tls: false })).toBe(
      false,
    );
    expect(await probeHealth({ host: null, port: await http({ body: "ok" }), tls: false })).toBe(false);
  });

  it("a body above 1 KiB is not healthy", async () => {
    const big = { body: JSON.stringify({ status: "ok", pad: "x".repeat(2048) }) };
    expect(await probeHealth({ host: null, port: await http(big), tls: false })).toBe(false);
  });

  it("a closed port is not healthy", async () => {
    const server = createHttp();
    const port = await listen(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeHealth({ host: null, port, tls: false })).toBe(false);
  });

  it("a server that never answers is not healthy within the timeout", async () => {
    const port = await listen(createHttp(() => undefined));
    expect(await probeHealth({ host: null, port, tls: false }, 50)).toBe(false);
  });

  it("the timeout is a total deadline: a server that drips bytes forever is not healthy", async () => {
    const port = await listen(
      createHttp((_req, res) => {
        res.writeHead(200);
        const drip = setInterval(() => res.write(" "), 10); // each byte resets an idle timer, never a total one
        res.on("close", () => clearInterval(drip));
      }),
    );
    expect(await probeHealth({ host: null, port, tls: false }, 150)).toBe(false);
  });

  it("asks the unit's own address: a server bound to 127.0.0.2 only answers a probe of 127.0.0.2", async () => {
    const server = createHttp(reply(OK));
    servers.push(server);
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.2", () => resolve((server.address() as AddressInfo).port)),
    );
    expect(await probeHealth({ host: "127.0.0.2", port, tls: false })).toBe(true);
    expect(await probeHealth({ host: null, port, tls: false })).toBe(false);
  });
});

describe("probeHost", () => {
  it("a wildcard or no host is loopback; a named host stays", () => {
    expect(probeHost(null)).toBe("127.0.0.1");
    expect(probeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(probeHost("")).toBe("127.0.0.1");
    expect(probeHost("::")).toBe("::1");
    expect(probeHost("[::]")).toBe("::1");
    expect(probeHost("192.0.2.1")).toBe("192.0.2.1");
    expect(probeHost("[fd00::5]")).toBe("fd00::5");
  });
});
