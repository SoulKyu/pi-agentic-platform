import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { startServer, type RunningServer } from "../../kernel/http/server.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { selfSignedCertificate } from "../../testing/self-signed.ts";
import { AUTH_MIGRATIONS, createAuthModule, type AuthModule } from "./index.ts";

// The Origin guard compares strings, so the real (ephemeral) port never has to match these.
const HTTP_ORIGIN = "http://localhost:7777";
const HTTPS_ORIGIN = "https://localhost:7777";
const PASSWORD = "correct horse battery staple";

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let dir: string;
let db: Db;
let auth: AuthModule;
let server: RunningServer;
let secure: boolean;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-auth-int-"));
  const clock = createFakeClock();
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  secure = false;
});
afterEach(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function boot(tls: boolean, publicOrigin = tls ? HTTPS_ORIGIN : HTTP_ORIGIN): Promise<void> {
  secure = tls;
  const origins = new Set([HTTP_ORIGIN, HTTPS_ORIGIN]);
  auth = createAuthModule({
    db,
    clock: createFakeClock(),
    logger: silentLogger,
    publicOrigin,
    allowedOrigins: origins,
  });
  const files = tls ? selfSignedCertificate(dir) : null;
  server = await startServer({
    app: createHttpApp({
      allowedOrigins: origins,
      staticRoot: null,
      logger: silentLogger,
      mount: (app) => auth.mount(app),
      wsProbe: (c) => c.json({}),
    }),
    host: "127.0.0.1",
    port: 0,
    tls: files ? { cert: readFileSync(files.cert), key: readFileSync(files.key) } : null,
    onUpgrade: (_req, socket) => socket.destroy(),
    onError: () => {},
  });
}

function exchange(
  headers: Record<string, string>,
  path: string,
  write: (req: ClientRequest) => void,
): Promise<Reply> {
  const options = {
    host: "127.0.0.1",
    port: server.port,
    method: "POST",
    path,
    rejectUnauthorized: false,
    headers: { origin: secure ? HTTPS_ORIGIN : HTTP_ORIGIN, "content-type": "application/json", ...headers },
  };
  return new Promise<Reply>((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    write(req);
  });
}

function send(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const payload = JSON.stringify(body);
  return exchange({ "content-length": String(Buffer.byteLength(payload)), ...headers }, path, (req) =>
    req.end(payload),
  );
}

const cookieOf = (reply: Reply) => (reply.headers["set-cookie"] ?? []).join("; ");
const setup = () =>
  send("/auth/setup", {
    token: new URL(auth.setupUrl() ?? "http://x").hash.replace("#token=", ""),
    username: "owner",
    password: PASSWORD,
  });
const login = (headers: Record<string, string> = {}, username = "owner", password = PASSWORD) =>
  send("/auth/login", { username, password }, headers);

describe("auth over a real socket", () => {
  it("decides Secure from the socket and the Host header, never from forwarded headers", async () => {
    await boot(false);
    const first = await setup();
    expect(first.status).toBe(201);
    expect(cookieOf(first)).not.toContain("Secure");
    const forged = {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "pap.example.net",
      "x-forwarded-for": "1.2.3.4",
      forwarded: "proto=https;host=pap.example.net;for=1.2.3.4",
    };
    expect(cookieOf(await login(forged))).not.toContain("Secure");
    expect(cookieOf(await login({ host: `localhost:${server.port}` }))).not.toContain("Secure");
    expect(cookieOf(await login({ host: `[::1]:${server.port}` }))).not.toContain("Secure");
    const foreign = await login({ host: "pap.example.net" });
    expect(foreign.status).toBe(200);
    expect(cookieOf(foreign)).toContain("Secure");
    expect(cookieOf(foreign)).toContain("HttpOnly");
  });

  it("keeps Secure on a plain-http loopback request when the public origin is https", async () => {
    await boot(false, HTTPS_ORIGIN);
    const first = await setup();
    expect(first.status).toBe(201);
    const value = cookieOf(first).split(";")[0] ?? "";
    expect(cookieOf(first)).toContain("Secure");
    expect(cookieOf(await login())).toContain("Secure");
    const out = await send("/auth/logout", {}, { cookie: value });
    expect(cookieOf(out)).toContain("Secure");
  });

  it("sets Secure when the daemon itself serves TLS, even on a loopback host", async () => {
    await boot(true);
    const reply = await setup();
    expect(reply.status).toBe(201);
    expect(cookieOf(reply)).toContain("Secure");
    expect(cookieOf(reply)).toContain("SameSite=Strict");
    const out = await send("/auth/logout", {}, { cookie: cookieOf(reply).split(";")[0] ?? "" });
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toContain("Secure");
  });

  it("throttles by the address of the socket, whatever X-Forwarded-For says", async () => {
    await boot(false);
    await setup();
    const wrong = (user: string, forwarded: string) =>
      login({ "x-forwarded-for": forwarded, forwarded: `for=${forwarded}` }, user, "wrong-password-123");
    expect((await wrong("ghost-a", "7.7.7.7")).status).toBe(401);
    const blocked = await wrong("ghost-b", "8.8.8.8");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("answers 413 above 16 KB when the length is declared, and when the body is chunked", async () => {
    await boot(false);
    const big = { username: "owner", password: "x".repeat(20_000) };
    const declared = await send("/auth/login", big);
    expect([declared.status, JSON.parse(declared.body)]).toEqual([
      413,
      { error: { code: "payload_too_large" } },
    ]);
    const chunked = await exchange({ "transfer-encoding": "chunked" }, "/auth/login", (req) => {
      req.write('{"username":"owner","password":"');
      req.write("x".repeat(20_000));
      req.end('"}');
    });
    expect([chunked.status, JSON.parse(chunked.body)]).toEqual([
      413,
      { error: { code: "payload_too_large" } },
    ]);
  });
});
