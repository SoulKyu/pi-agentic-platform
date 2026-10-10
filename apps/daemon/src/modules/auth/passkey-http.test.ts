import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createHttpApp } from "../../kernel/http/app.ts";
import { createLogger } from "../../kernel/logger.ts";
import { AUTH_MIGRATIONS, createAuthModule, type AuthModule } from "./index.ts";

const ORIGIN = "http://localhost:7777";
const PASSWORD = "correct horse battery staple";
let dir: string;
let db: Db;
let clock: FakeClock;
let lines: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-passkey-http-"));
  clock = createFakeClock();
  lines = [];
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS],
    clock,
    logger: createLogger({ level: "debug", clock, write: (line) => lines.push(line) }),
  }).db;
  lines.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function moduleFor(publicOrigin: string): { auth: AuthModule; app: Hono } {
  const logger = createLogger({ level: "debug", clock, write: (line) => lines.push(line) });
  const allowedOrigins = new Set([publicOrigin]);
  const auth = createAuthModule({ db, clock, logger, publicOrigin, allowedOrigins });
  const app = createHttpApp({
    allowedOrigins,
    staticRoot: null,
    logger,
    mount: (a) => auth.mount(a),
    wsProbe: (c) => c.json({}),
  });
  return { auth, app };
}
const appFor = (publicOrigin: string) => moduleFor(publicOrigin).app;
const socketAt = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
const post = (app: Hono, path: string, body?: unknown, headers: Record<string, string> = {}, env?: object) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
const events = (name: string) =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.msg === name);
const GARBAGE = { flowId: "not-a-flow", response: { id: "AAAA" } };

describe("passkey routes", () => {
  it("reports availability from the public origin", async () => {
    expect(await (await appFor(ORIGIN).request("/auth/status")).json()).toMatchObject({
      passkeysAvailable: true,
    });
    expect(await (await appFor("http://127.0.0.1:7777").request("/auth/status")).json()).toMatchObject({
      passkeysAvailable: false,
    });
  });

  it("requires a session to register a passkey", async () => {
    const app = appFor(ORIGIN);
    for (const path of ["/auth/passkey/register/options", "/auth/passkey/register/verify"]) {
      const response = await post(app, path, GARBAGE);
      expect([response.status, await response.json()], path).toEqual([
        401,
        { error: { code: "unauthenticated" } },
      ]);
      const forged = await post(app, path, GARBAGE, { cookie: "pap_session=forged" });
      expect(forged.status, path).toBe(401);
    }
  });

  it("returns login options with a flow id that demands user verification", async () => {
    const response = await post(appFor(ORIGIN), "/auth/passkey/login/options");
    const body = (await response.json()) as {
      flowId: string;
      options: { challenge: string; rpId: string; userVerification: string; allowCredentials: unknown[] };
    };
    expect(body.flowId.length).toBeGreaterThan(10);
    expect(body.options.rpId).toBe("localhost");
    expect(body.options.userVerification).toBe("required");
    expect(body.options.allowCredentials).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 on every passkey route when the origin is an IP address", async () => {
    const ip = "http://127.0.0.1:7777";
    const { auth, app } = moduleFor(ip);
    const token = new URL(auth.setupUrl() ?? "http://x").hash.replace("#token=", "");
    const setup = await post(
      app,
      "/auth/setup",
      { token, username: "owner", password: PASSWORD },
      { origin: ip },
    );
    const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    for (const path of ["login/options", "login/verify", "register/options", "register/verify"]) {
      const signedOut = await post(app, `/auth/passkey/${path}`, GARBAGE, { origin: ip });
      expect(signedOut.status, path).toBe(path.startsWith("login") ? 404 : 401);
      const signedIn = await post(app, `/auth/passkey/${path}`, GARBAGE, { origin: ip, cookie });
      expect([signedIn.status, await signedIn.json()], path).toEqual([404, { error: { code: "not_found" } }]);
    }
    expect(events("auth_passkey_failed")).toEqual([]);
  });

  it("answers 400 to a malformed verify body without counting it against the sender", async () => {
    const app = appFor(ORIGIN);
    for (const body of [
      "{broken",
      "null",
      {},
      { flowId: "", response: {} },
      { flowId: "x", response: "no" },
    ]) {
      const response = await post(app, "/auth/passkey/login/verify", body);
      expect([response.status, await response.json()]).toEqual([400, { error: { code: "bad_request" } }]);
    }
    expect(events("auth_passkey_failed")).toEqual([]);
  });

  it("answers an unusable assertion with a fixed 401, logs ip and delay only, then throttles that address", async () => {
    const app = appFor(ORIGIN);
    const attempt = () => post(app, "/auth/passkey/login/verify", GARBAGE, {}, socketAt("10.0.0.9"));
    const failed = await attempt();
    expect([failed.status, await failed.json()]).toEqual([401, { error: { code: "unauthenticated" } }]);
    expect(failed.headers.get("set-cookie")).toBeNull();
    const [entry] = events("auth_passkey_failed");
    expect(entry).toMatchObject({ level: "warn", ip: "10.0.0.9", retryAfterMs: 1000 });
    expect(Object.keys(entry ?? {}).sort()).toEqual(["ip", "level", "module", "msg", "retryAfterMs", "time"]);
    expect(entry?.module).toBe("auth");

    const throttled = await attempt();
    expect([throttled.status, await throttled.json()]).toEqual([429, { error: { code: "rate_limited" } }]);
    expect(Number(throttled.headers.get("retry-after"))).toBe(1);
    expect(events("auth_passkey_failed")).toHaveLength(1);

    const other = await post(app, "/auth/passkey/login/verify", GARBAGE, {}, socketAt("10.0.0.10"));
    expect(other.status).toBe(401);
    await clock.advance(1000);
    expect((await attempt()).status).toBe(401);
    expect(events("auth_passkey_failed").map((e) => e.retryAfterMs)).toEqual([1000, 1000, 2000]);
  });

  it("keeps passkey failures off the password keys, and password failures off the passkey key", async () => {
    const { auth, app } = moduleFor(ORIGIN);
    const token = new URL(auth.setupUrl() ?? "http://x").hash.replace("#token=", "");
    const setup = await post(app, "/auth/setup", { token, username: "owner", password: PASSWORD });
    expect(setup.status).toBe(201);
    await clock.advance(5000);

    const ip = socketAt("10.0.0.9");
    expect((await post(app, "/auth/passkey/login/verify", GARBAGE, {}, ip)).status).toBe(401);
    expect((await post(app, "/auth/passkey/login/verify", GARBAGE, {}, ip)).status).toBe(429);
    const password = await post(app, "/auth/login", { username: "owner", password: PASSWORD }, {}, ip);
    expect(password.status).toBe(200);

    await clock.advance(5000);
    const wrong = { username: "owner", password: "wrong-password-123" };
    expect((await post(app, "/auth/login", wrong, {}, socketAt("10.0.0.20"))).status).toBe(401);
    expect((await post(app, "/auth/login", wrong, {}, socketAt("10.0.0.20"))).status).toBe(429);
    expect((await post(app, "/auth/passkey/login/verify", GARBAGE, {}, socketAt("10.0.0.20"))).status).toBe(
      401,
    );
  });

  it("reads no forwarded header: the throttle key is the socket address", async () => {
    const app = appFor(ORIGIN);
    const forged = (address: string) => ({ "x-forwarded-for": address, forwarded: `for=${address}` });
    expect(
      (await post(app, "/auth/passkey/login/verify", GARBAGE, forged("7.7.7.7"), socketAt("10.0.0.1")))
        .status,
    ).toBe(401);
    expect(
      (await post(app, "/auth/passkey/login/verify", GARBAGE, forged("8.8.8.8"), socketAt("10.0.0.1")))
        .status,
    ).toBe(429);
    expect(
      (await post(app, "/auth/passkey/login/verify", GARBAGE, forged("7.7.7.7"), socketAt("10.0.0.2")))
        .status,
    ).toBe(401);
  });

  it("answers 403 to a passkey POST without an allowed Origin", async () => {
    const app = appFor(ORIGIN);
    for (const origin of [undefined, "http://evil.example", "null"]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin) headers.origin = origin;
      const response = await app.request("/auth/passkey/login/options", { method: "POST", headers });
      expect(response.status, String(origin)).toBe(403);
    }
  });
});
