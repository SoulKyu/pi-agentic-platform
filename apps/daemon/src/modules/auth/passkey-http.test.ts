import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import { mountAuthRoutes } from "./http.ts";
import { mountPasskeyRoutes } from "./passkey-http.ts";
import type { PasskeyService } from "./passkeys.ts";
import { createAuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createAuthTestBed, PASSWORD, setupTokenOf, type AuthTestBed } from "./testing/fixture.ts";
import { createThrottle } from "./throttle.ts";

const ORIGIN = "http://localhost:7777";
let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => {
  bed.dispose();
});

const moduleFor = (publicOrigin: string) => bed.start(publicOrigin);
const appFor = (publicOrigin: string) => moduleFor(publicOrigin).app;
const events = (name: string) => bed.events(name);
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
    expect(body.flowId).toBe(body.options.challenge);
    expect(body.options.rpId).toBe("localhost");
    expect(body.options.userVerification).toBe("required");
    expect(body.options.allowCredentials).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 on every passkey route when the origin is an IP address", async () => {
    const ip = "http://127.0.0.1:7777";
    const { auth, app } = moduleFor(ip);
    const token = setupTokenOf(auth);
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
    const spent = await post(
      app,
      "/auth/passkey/register/options",
      { password: "wrong-password-123" },
      { origin: ip, cookie },
    );
    expect(spent.status).toBe(404);
    expect(events("auth_passkey_failed")).toEqual([]);
    expect(events("auth_login_failed")).toEqual([]);
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
    await bed.clock.advance(1000);
    expect((await attempt()).status).toBe(401);
    expect(events("auth_passkey_failed").map((e) => e.retryAfterMs)).toEqual([1000, 1000, 2000]);
  });

  it("keeps passkey failures off the password keys, and password failures off the passkey key", async () => {
    const { auth, app } = moduleFor(ORIGIN);
    const token = setupTokenOf(auth);
    const setup = await post(app, "/auth/setup", { token, username: "owner", password: PASSWORD });
    expect(setup.status).toBe(201);
    await bed.clock.advance(5000);

    const ip = socketAt("10.0.0.9");
    expect((await post(app, "/auth/passkey/login/verify", GARBAGE, {}, ip)).status).toBe(401);
    expect((await post(app, "/auth/passkey/login/verify", GARBAGE, {}, ip)).status).toBe(429);
    const password = await post(app, "/auth/login", { username: "owner", password: PASSWORD }, {}, ip);
    expect(password.status).toBe(200);

    await bed.clock.advance(5000);
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

describe("step-up before enrollment", () => {
  async function spied() {
    const setupToken = createSetupToken(true);
    const service = createAuthService({
      store: createAuthStore(bed.db),
      clock: bed.clock,
      logger: bed.logger.child({ module: "auth" }),
      publicOrigin: ORIGIN,
      throttle: createThrottle(bed.clock),
      setupToken,
    });
    const registerOptions = vi.fn(() => Promise.resolve({ flowId: "flow-1", options: {} }));
    const passkeys = { available: true, registerOptions } as unknown as PasskeyService;
    const app = createHttpApp({
      allowedOrigins: new Set([ORIGIN]),
      staticRoot: null,
      logger: bed.logger,
      mount: (a) => {
        mountAuthRoutes(a, { service, passkeysAvailable: true, secureByConfig: false });
        mountPasskeyRoutes(a, {
          passkeys,
          auth: service,
          throttle: createThrottle(bed.clock),
          logger: bed.logger,
        });
      },
      wsProbe: (c) => c.json({}),
    });
    const session = await service.setup({
      token: setupToken.current() ?? "",
      username: "owner",
      password: PASSWORD,
      ip: "127.0.0.1",
      userAgent: undefined,
    });
    bed.lines.length = 0;
    return { app, registerOptions, cookie: `pap_session=${session.cookieValue}` };
  }
  const WRONG = { password: "wrong-password-123" };

  it("creates no enrollment flow without the right password, and counts guesses on the password keys", async () => {
    const { app, registerOptions, cookie } = await spied();
    const options = (body: unknown, address = "10.0.0.9") =>
      post(app, "/auth/passkey/register/options", body, { cookie }, socketAt(address));
    for (const body of [undefined, {}, { password: "" }, { password: 7 }, "{broken"]) {
      const bad = await options(body);
      expect([bad.status, await bad.json()], JSON.stringify(body)).toEqual([
        400,
        { error: { code: "bad_request" } },
      ]);
    }
    const wrong = await options(WRONG);
    expect([wrong.status, await wrong.json()]).toEqual([401, { error: { code: "unauthenticated" } }]);
    for (const body of [WRONG, { password: PASSWORD }]) {
      const throttled = await options(body);
      expect([throttled.status, await throttled.json()]).toEqual([429, { error: { code: "rate_limited" } }]);
      expect(Number(throttled.headers.get("retry-after"))).toBe(1);
    }
    // The same account key serves sign-in, so a guess here delays a sign-in from anywhere.
    const login = await post(
      app,
      "/auth/login",
      { username: "owner", password: PASSWORD },
      {},
      socketAt("10.0.0.50"),
    );
    expect(login.status).toBe(429);
    expect(registerOptions).not.toHaveBeenCalled();

    await bed.clock.advance(1000);
    const right = await options({ password: PASSWORD });
    expect([right.status, await right.json()]).toEqual([200, { flowId: "flow-1", options: {} }]);
    expect(registerOptions).toHaveBeenCalledTimes(1);
  });

  it("answers a stolen session without the password like a failed sign-in, logging address and delay only", async () => {
    const { app, cookie } = await spied();
    await post(app, "/auth/passkey/register/options", WRONG, { cookie }, socketAt("10.0.0.9"));
    const [entry] = events("auth_login_failed");
    expect(entry).toMatchObject({ level: "warn", ip: "10.0.0.9", retryAfterMs: 1000 });
    expect(Object.keys(entry ?? {}).sort()).toEqual(["ip", "level", "module", "msg", "retryAfterMs", "time"]);
    expect(bed.lines.join("")).not.toContain(WRONG.password);
    expect(bed.lines.join("")).not.toContain("owner");
  });

  it("needs the session before it looks at the body or the password", async () => {
    const { app, registerOptions } = await spied();
    const anonymous = await post(app, "/auth/passkey/register/options", WRONG);
    expect(anonymous.status).toBe(401);
    expect(events("auth_login_failed")).toEqual([]);
    expect(registerOptions).not.toHaveBeenCalled();
  });
});
