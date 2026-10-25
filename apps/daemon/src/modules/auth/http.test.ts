import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../kernel/logger.ts";
import type { AuthModule } from "./index.ts";
import { createAuthTestBed, PASSWORD, setupTokenOf, type AuthTestBed } from "./testing/fixture.ts";

const ORIGIN = "http://localhost:7777";
const ORIGINS = new Set([
  ORIGIN,
  "http://127.0.0.1:7777",
  "http://[::1]:7777",
  "https://localhost:7777",
  "http://pap.example.net:7777",
  "https://pap.example.net",
]);
const owner = { username: "owner", password: PASSWORD };

let bed: AuthTestBed;
let auth: AuthModule;
let app: Hono;
beforeEach(() => {
  bed = createAuthTestBed();
  ({ auth, app } = bed.start(ORIGIN, ORIGINS));
});
afterEach(() => {
  bed.dispose();
});

const socketAt = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
const postTo = (
  target: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  env?: object,
) =>
  target.request(
    path,
    {
      method: "POST",
      headers: { origin: new URL(path, ORIGIN).origin, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    env,
  );
const post = (path: string, body: unknown, headers: Record<string, string> = {}, env?: object) =>
  postTo(app, path, body, headers, env);
const token = () => setupTokenOf(auth);
const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const setup = () => post("/auth/setup", { token: token(), ...owner });

describe("auth routes", () => {
  it("reports an anonymous, not yet set up daemon", async () => {
    const response = await app.request("/auth/status");
    expect(await response.json()).toEqual({
      setupRequired: true,
      authenticated: false,
      username: null,
      role: null,
      passkeysAvailable: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("setup answers 201 with an HttpOnly, SameSite=Strict, 30-day cookie that authenticates", async () => {
    const response = await setup();
    expect(response.status).toBe(201);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^pap_session=[\w-]{43,};/);
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) {
      expect(cookie).toContain(attribute);
    }
    expect(cookie).not.toContain("Domain=");
    const value = cookieOf(response);
    expect(auth.authenticateCookieHeader(value)?.userId).toBeTruthy();
    const status = await (await app.request("/auth/status", { headers: { cookie: value } })).json();
    expect(status).toMatchObject({ setupRequired: false, authenticated: true, username: "owner" });
  });

  it("sets Secure for https and for any non-loopback host, never for plain-http loopback", async () => {
    await setup();
    const cases: [string, boolean][] = [
      ["http://localhost:7777", false],
      ["http://127.0.0.1:7777", false],
      ["http://[::1]:7777", false],
      ["http://pap.example.net:7777", true],
      ["https://localhost:7777", true],
      ["https://pap.example.net", true],
    ];
    for (const [base, secure] of cases) {
      const login = await post(`${base}/auth/login`, owner);
      const set = login.headers.get("set-cookie") ?? "";
      expect(login.status, base).toBe(200);
      expect(set.includes("Secure"), `${base} login: ${set}`).toBe(secure);
      expect(set, base).toContain("HttpOnly");
      expect(set, base).toContain("SameSite=Strict");
      expect(set, base).not.toContain("Domain=");
      const out = await post(`${base}/auth/logout`, {}, { cookie: cookieOf(login) });
      const cleared = out.headers.get("set-cookie") ?? "";
      expect(cleared.includes("Secure"), `${base} logout: ${cleared}`).toBe(secure);
      expect(cleared, base).toContain("Max-Age=0");
      expect(cleared, base).not.toContain("Domain=");
    }
  });

  it("drops Secure for a plain-http LAN address only with --insecure-http", async () => {
    const LAN = "http://192.168.1.20:7777";
    await setup();
    for (const [insecureHttp, secure] of [
      [false, true],
      [true, false],
    ] as const) {
      const lan = bed.start(LAN, new Set([LAN]), insecureHttp).app;
      const login = await lan.request(`${LAN}/auth/login`, {
        method: "POST",
        headers: { origin: LAN, "content-type": "application/json" },
        body: JSON.stringify(owner),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie") ?? "";
      expect(cookie.includes("Secure"), `insecureHttp=${insecureHttp}`).toBe(secure);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
    }
  });

  it("keeps Secure on plain-http loopback requests when the public origin is https (R24b)", async () => {
    await setup();
    const proxied = bed.start("https://pap.example.net", ORIGINS).app;
    for (const base of ["http://127.0.0.1:7777", "http://localhost:7777", "http://[::1]:7777"]) {
      const login = await postTo(proxied, `${base}/auth/login`, owner);
      expect(login.status, base).toBe(200);
      const value = cookieOf(login);
      const status = await proxied.request(`${base}/auth/status`, { headers: { cookie: value } });
      const out = await postTo(proxied, `${base}/auth/logout`, {}, { cookie: value });
      const cookies = [login, status, out].map((response) => response.headers.get("set-cookie") ?? "");
      for (const cookie of cookies) {
        expect(cookie, base).toContain("Secure");
        expect(cookie, base).toContain("HttpOnly");
        expect(cookie, base).toContain("SameSite=Strict");
      }
      expect(cookies[1], base).toContain("Max-Age=2592000");
      expect(cookies[2], base).toContain("Max-Age=0");
    }
  });

  it("refreshes the browser cookie when the status call finds a live session", async () => {
    const value = cookieOf(await setup());
    const response = await app.request("/auth/status", { headers: { cookie: value } });
    expect(response.headers.get("set-cookie")).toContain(`${value};`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=2592000");
    const stale = await app.request("/auth/status", { headers: { cookie: "pap_session=forged" } });
    expect(stale.headers.get("set-cookie")).toBeNull();
  });

  it("answers 401 with a fixed code, then 429 with Retry-After", async () => {
    await setup();
    const bad = await post("/auth/login", { username: "owner", password: "wrong-password-123" });
    expect([bad.status, await bad.json()]).toEqual([401, { error: { code: "unauthenticated" } }]);
    const throttled = await post("/auth/login", owner);
    expect([throttled.status, await throttled.json()]).toEqual([429, { error: { code: "rate_limited" } }]);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses a wrong setup token and a second setup with the same fixed 401", async () => {
    const wrong = await post("/auth/setup", { token: "not-the-token", ...owner });
    expect([wrong.status, await wrong.json()]).toEqual([401, { error: { code: "unauthenticated" } }]);
    await bed.clock.advance(1000);
    expect((await setup()).status).toBe(201);
    const again = await post("/auth/setup", { token: "anything", ...owner, username: "second" });
    expect(again.status).toBe(401);
  });

  it("logout clears the cookie and the session", async () => {
    const value = cookieOf(await setup());
    const out = await post("/auth/logout", {}, { cookie: value });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(auth.authenticateCookieHeader(value)).toBeNull();
  });

  it("answers 403 to an auth POST without an Origin, with a foreign one, or with null", async () => {
    for (const path of ["/auth/setup", "/auth/login", "/auth/logout"]) {
      for (const origin of [
        undefined,
        "http://evil.example",
        "https://pap.example.net.evil.example",
        "null",
      ]) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (origin) headers.origin = origin;
        const response = await app.request(path, { method: "POST", headers, body: JSON.stringify(owner) });
        expect([response.status, await response.json()], `${path} ${origin}`).toEqual([
          403,
          { error: { code: "forbidden" } },
        ]);
        expect(response.headers.get("set-cookie"), `${path} ${origin}`).toBeNull();
      }
    }
    expect(bed.db.get<{ c: number }>("SELECT count(*) AS c FROM users")?.c).toBe(0);
  });

  it("offers no setup URL and refuses setup after a restart over a database that has an owner", async () => {
    const secret = token();
    expect((await setup()).status).toBe(201);
    const { auth: restarted, app: target } = bed.start(ORIGIN, ORIGINS);
    expect(restarted.setupUrl()).toBeNull();
    for (const candidate of [secret, "never-issued"]) {
      const response = await postTo(target, "/auth/setup", {
        token: candidate,
        ...owner,
        username: "second",
      });
      expect([response.status, await response.json()]).toEqual([401, { error: { code: "unauthenticated" } }]);
      await bed.clock.advance(2000);
    }
    expect(bed.db.get<{ c: number }>("SELECT count(*) AS c FROM users")?.c).toBe(1);
    expect((await target.request("/auth/status")).headers.get("set-cookie")).toBeNull();
  });

  it("validates input with a fixed 400 that never echoes it", async () => {
    const fixed = { error: { code: "bad_request" } };
    const eleven = "only-11-chr";
    const cases: unknown[] = [
      { token: token(), username: "bad name!", password: PASSWORD },
      { token: token(), username: "owner", password: eleven },
      { token: token(), username: "owner" },
      { token: token(), username: "x".repeat(65), password: PASSWORD },
      "not json {",
      "null",
      "[]",
    ];
    for (const body of cases) {
      const response = await post("/auth/setup", body);
      const text = await response.text();
      expect([response.status, JSON.parse(text)], JSON.stringify(body)).toEqual([400, fixed]);
      expect(text).not.toContain(eleven);
    }
    expect((await post("/auth/login", { username: "owner" })).status).toBe(400);
    expect((await setup()).status).toBe(201);
  });

  it("answers 413 above 16 KB, with or without a declared length, and 400 just under it", async () => {
    const body = JSON.stringify({ username: "owner", password: "x".repeat(16 * 1024) });
    const undeclared = await post("/auth/login", body);
    expect([undeclared.status, await undeclared.json()]).toEqual([
      413,
      { error: { code: "payload_too_large" } },
    ]);
    const declared = await post("/auth/login", body, { "content-length": String(body.length) });
    expect([declared.status, await declared.json()]).toEqual([413, { error: { code: "payload_too_large" } }]);
    const under = JSON.stringify({ username: "owner", password: "x".repeat(15 * 1024) });
    expect((await post("/auth/login", under)).status).toBe(400);
    expect(bed.lines.filter((line) => line.includes("http_error"))).toEqual([]);
  });

  it("keys the throttle on the socket address, not on forwarded headers", async () => {
    await setup();
    const forged = (address: string) => ({ "x-forwarded-for": address, forwarded: `for=${address}` });
    const miss = (user: string, address: string, socket: string) =>
      post(
        "/auth/login",
        { username: user, password: "wrong-password-123" },
        forged(address),
        socketAt(socket),
      );
    expect((await miss("ghost-a", "7.7.7.7", "10.0.0.1")).status).toBe(401);
    expect((await miss("ghost-b", "8.8.8.8", "10.0.0.1")).status).toBe(429);
    expect((await miss("ghost-c", "7.7.7.7", "10.0.0.2")).status).toBe(401);
  });

  it("logs failures with the socket address and the delay, never the username or password", async () => {
    const name = "grace.hopper";
    const guess = "super-secret-guess-123";
    expect((await post("/auth/setup", { token: token(), username: name, password: PASSWORD })).status).toBe(
      201,
    );
    await bed.clock.advance(2000);
    const attempt = () => post("/auth/login", { username: name, password: guess }, {}, socketAt("10.0.0.9"));
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    const entries = bed.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((entry) => entry.msg)).toEqual([
      "owner_created",
      "auth_login_failed",
      "auth_throttled",
    ]);
    expect(entries.slice(1).map((entry) => [entry.ip, entry.retryAfterMs])).toEqual([
      ["10.0.0.9", 1000],
      ["10.0.0.9", 1000],
    ]);
    for (const secret of [name, guess, PASSWORD]) expect(bed.lines.join(""), secret).not.toContain(secret);
  });

  it("leaves 404 for GET and POST on unknown auth paths", async () => {
    expect((await app.request("/auth/nothing")).status).toBe(404);
    expect((await post("/auth/nothing", {})).status).toBe(404);
  });
});

describe("the one-time setup url", () => {
  it("is never in a response, an error or a log line, and printing it through the logger keeps it intact", async () => {
    const url = auth.setupUrl() ?? "";
    const secret = token();
    expect(bed.lines).toEqual([]);
    const attempts = [
      () => app.request("/auth/status"),
      () => post("/auth/setup", { token: `${secret}x`, ...owner }),
      () => post("/auth/setup", { token: secret, username: "owner", password: "short" }),
      () => post("/auth/setup", "{broken"),
      () => setup(),
      () => post("/auth/setup", { token: secret, ...owner, username: "second" }),
    ];
    for (const attempt of attempts) {
      expect(await (await attempt()).text()).not.toContain(secret);
      await bed.clock.advance(2000);
    }
    expect(bed.lines.join("")).not.toContain(secret);
    expect(bed.lines.join("")).not.toContain(PASSWORD);

    const printed: string[] = [];
    createLogger({ level: "info", clock: bed.clock, write: (line) => printed.push(line) }).info("setup_url", {
      url,
    });
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0] ?? "{}")).toMatchObject({ msg: "setup_url", url });
    expect(url).toBe(`${ORIGIN}/setup#token=${secret}`);
    expect(auth.setupUrl()).toBeNull();
  });
});
