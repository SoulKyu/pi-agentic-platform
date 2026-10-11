import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../logger.ts";
import { createHttpApp } from "./app.ts";
import { startServer } from "./server.ts";

const app = new Hono().get("/healthz", (c) => c.json({ status: "ok" }));
const noUpgrade = (_req: unknown, socket: { destroy(): void }) => socket.destroy();
const listenOn = (port: number, onError: (error: Error) => void = () => {}) =>
  startServer({ app, host: "127.0.0.1", port, tls: null, onUpgrade: noUpgrade, onError });

describe("startServer", () => {
  it("serves on an ephemeral port and closes", async () => {
    const server = await listenOn(0);
    expect(await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json()).toEqual({ status: "ok" });
    await server.close();
  });

  it("rejects a port already in use", async () => {
    const first = await listenOn(0);
    await expect(listenOn(first.port)).rejects.toThrow(/EADDRINUSE/);
    await first.close();
  });

  it("keeps an error listener for the server's whole life, so a late error is handed on, not thrown (R75)", async () => {
    // hono's serve() creates the node server; its listen() call is the one place the instance can be taken from.
    const listen = vi.spyOn(Server.prototype, "listen");
    const onError = vi.fn();
    const server = await listenOn(0, onError);
    const instance = listen.mock.contexts[0] as Server;
    listen.mockRestore();
    const late = Object.assign(new Error("accept failed"), { code: "EMFILE" });
    expect(() => instance.emit("error", late)).not.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(late);
    await server.close();
  });
});

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

// fetch normalises the target; node:http sends the request line exactly as given (the adapter still parses it).
const raw = (port: number, method: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<RawResponse>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });

describe("http app over a real socket", () => {
  let dir: string;
  let close: () => Promise<void>;
  let port: number;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pap-http-int-"));
    mkdirSync(join(dir, "web"));
    writeFileSync(join(dir, "web", "index.html"), "<title>pap</title>");
    writeFileSync(join(dir, "secret.txt"), "do not serve");
    const server = await startServer({
      app: createHttpApp({
        allowedOrigins: new Set(["http://localhost:7777"]),
        staticRoot: join(dir, "web"),
        logger: silentLogger,
        mount: (hono) => {
          hono.get("/probe", (c) => c.json({ protocol: new URL(c.req.url).protocol }));
          hono.post("/auth/echo", (c) => c.json({ ok: true }));
        },
        wsProbe: (c) => c.json({ protocol: 1 }),
      }),
      host: "127.0.0.1",
      port: 0,
      tls: null,
      onUpgrade: noUpgrade,
      onError: () => {},
    });
    ({ port, close } = server);
  });
  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers traversal request lines sent verbatim with a bare 404", async () => {
    for (const path of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/..\\secret.txt",
      "/%00",
    ]) {
      const response = await raw(port, "GET", path);
      expect(response.status, path).toBe(404);
      expect(response.body, path).not.toContain("do not serve");
      expect(response.body, path).not.toContain(dir);
    }
    expect((await raw(port, "GET", "/s/abc")).body).toContain("<title>pap</title>");
  });

  it("derives the scheme from the socket and ignores forwarded headers", async () => {
    const forged = { "x-forwarded-proto": "https", "x-forwarded-for": "1.2.3.4", forwarded: "proto=https" };
    expect(JSON.parse((await raw(port, "GET", "/probe", forged)).body)).toEqual({ protocol: "http:" });
    const post = (origin: string) => raw(port, "POST", "/auth/echo", { ...forged, origin });
    expect((await post("https://localhost:7777")).status).toBe(403);
    expect((await post("http://localhost:7777")).status).toBe(200);
  });
});
