import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthModule } from "./index.ts";
import { createAuthTestBed, PASSWORD, setupTokenOf, type AuthTestBed } from "./testing/fixture.ts";

const ORIGIN = "http://localhost:7777";
const GOOD = PASSWORD;
const BAD = "wrong password!!";
const OWNER_ADDRESS = "10.0.0.1";

let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => {
  bed.dispose();
});

const socketAt = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
const post = (app: Hono, path: string, body: unknown, headers: Record<string, string> = {}, ip?: string) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    socketAt(ip ?? OWNER_ADDRESS),
  );
const login = (app: Hono, input: { password: string; ip?: string }) =>
  post(app, "/auth/login", { username: "owner", password: input.password }, {}, input.ip);
const confirm = (app: Hono, input: { cookie?: string; password: string; ip?: string }) =>
  post(
    app,
    "/auth/confirm",
    { password: input.password },
    input.cookie ? { cookie: input.cookie } : {},
    input.ip,
  );
const enrollOptions = (app: Hono, input: { cookie: string; password: string }) =>
  post(app, "/auth/passkey/register/options", { password: input.password }, { cookie: input.cookie });
const logout = (app: Hono, cookie: string) => post(app, "/auth/logout", {}, { cookie });
const sessionCookieOf = (response: Response): string =>
  (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function authBed(): Promise<{ app: Hono; auth: AuthModule; clock: AuthTestBed["clock"] }> {
  const { auth, app } = bed.start(ORIGIN);
  const setup = await post(app, "/auth/setup", {
    token: setupTokenOf(auth),
    username: "owner",
    password: GOOD,
  });
  expect(setup.status).toBe(201);
  await bed.clock.advance(5000);
  return { app, auth, clock: bed.clock };
}

describe("POST /auth/confirm", () => {
  it("needs a session and the right password, marks the session for 5 minutes, and forgets it at sign-out", async () => {
    const { app, auth, clock } = await authBed();
    expect((await confirm(app, { password: GOOD })).status).toBe(401);
    const cookie = sessionCookieOf(await login(app, { password: GOOD }));
    expect((await confirm(app, { cookie, password: BAD })).status).toBe(401);
    await clock.advance(1000);
    expect((await confirm(app, { cookie, password: GOOD })).status).toBe(204);
    expect(auth.authenticateCookieHeader(cookie)?.stepUpUntil).toBe(clock.now() + 5 * 60_000);
    await logout(app, cookie);
    const again = sessionCookieOf(await login(app, { password: GOOD }));
    expect(auth.authenticateCookieHeader(again)?.stepUpUntil).toBe(0);
    expect(auth.authenticateCookieHeader(cookie)).toBeNull();
  });

  it("leaves a second session of the owner unconfirmed while the first is marked", async () => {
    const { app, auth } = await authBed();
    const first = sessionCookieOf(await login(app, { password: GOOD }));
    const second = sessionCookieOf(await login(app, { password: GOOD }));
    await confirm(app, { cookie: first, password: GOOD });
    expect(auth.authenticateCookieHeader(first)?.stepUpUntil).toBeGreaterThan(0);
    expect(auth.authenticateCookieHeader(second)?.stepUpUntil).toBe(0);
  });

  it("lets the mark run out after 5 minutes", async () => {
    const { app, auth, clock } = await authBed();
    const cookie = sessionCookieOf(await login(app, { password: GOOD }));
    await confirm(app, { cookie, password: GOOD });
    const until = auth.authenticateCookieHeader(cookie)?.stepUpUntil ?? 0;
    await clock.advance(5 * 60_000);
    expect(until).toBe(clock.now());
    expect(auth.authenticateCookieHeader(cookie)?.stepUpUntil).toBe(until);
  });

  it("confirms the password and enrolls a passkey while the username is under attack (RT-06, Q10)", async () => {
    const { app } = await authBed();
    const cookie = sessionCookieOf(await login(app, { password: GOOD }));
    // An attacker without the cookie hammers the account key, from the owner's own address (a shared proxy).
    for (let i = 0; i < 20; i++) await login(app, { password: BAD });
    expect((await login(app, { password: GOOD })).status).toBe(429);
    expect((await confirm(app, { cookie, password: GOOD })).status).toBe(204);
    expect((await enrollOptions(app, { cookie, password: GOOD })).status).toBe(200);
  });

  it("throttles a stolen cookie's guesses on that session alone", async () => {
    const { app } = await authBed();
    const stolen = sessionCookieOf(await login(app, { password: GOOD }));
    const owner = sessionCookieOf(await login(app, { password: GOOD }));
    await confirm(app, { cookie: stolen, password: "guess one guess" });
    const blocked = await confirm(app, { cookie: stolen, password: GOOD });
    expect([blocked.status, await blocked.json()]).toEqual([429, { error: { code: "rate_limited" } }]);
    expect(blocked.headers.get("retry-after")).toBe("1");
    expect((await confirm(app, { cookie: owner, password: GOOD })).status).toBe(204);
    expect((await login(app, { password: GOOD })).status).toBe(200);
  });

  it("keeps the lockouts of an account and of a stolen session through a spray of setup requests from 10 000 addresses", async () => {
    const { app } = await authBed();
    const stolen = sessionCookieOf(await login(app, { password: GOOD }));
    const owner = sessionCookieOf(await login(app, { password: GOOD }));
    for (let i = 0; i < 10; i++) {
      await confirm(app, { cookie: stolen, password: BAD });
      await login(app, { password: BAD });
      if (i < 9) await bed.clock.advance(60_000);
    }
    const wait = async (response: Response | Promise<Response>) => {
      const reply = await response;
      return [reply.status, reply.headers.get("retry-after")];
    };
    expect(await wait(login(app, { password: GOOD, ip: "10.8.8.8" }))).toEqual([429, "60"]);
    expect(await wait(confirm(app, { cookie: stolen, password: GOOD }))).toEqual([429, "60"]);
    for (let i = 0; i < 10_000; i++) {
      const spray = await post(
        app,
        "/auth/setup",
        { token: "t", username: "x", password: BAD },
        {},
        `2001:db8::${i.toString(16)}`,
      );
      expect(spray.status).toBe(401);
    }
    expect(await wait(login(app, { password: GOOD, ip: "10.8.8.9" }))).toEqual([429, "60"]);
    expect(await wait(confirm(app, { cookie: stolen, password: GOOD }))).toEqual([429, "60"]);
    expect((await confirm(app, { cookie: owner, password: GOOD })).status).toBe(204);
  }, 60_000);

  it("refuses a foreign origin and a malformed body", async () => {
    const { app } = await authBed();
    const cookie = sessionCookieOf(await login(app, { password: GOOD }));
    const foreign = await post(
      app,
      "/auth/confirm",
      { password: GOOD },
      { cookie, origin: "http://evil.example" },
    );
    expect(foreign.status).toBe(403);
    for (const body of [{}, { password: "" }, { password: 7 }, { password: "x".repeat(1025) }]) {
      const bad = await post(app, "/auth/confirm", body, { cookie });
      expect([bad.status, await bad.json()], JSON.stringify(body)).toEqual([
        400,
        { error: { code: "bad_request" } },
      ]);
    }
    expect(bed.audited).toEqual([]);
  });

  it("logs a wrong password with the address only, and audits step_up once per success", async () => {
    const { app, auth } = await authBed();
    const cookie = sessionCookieOf(await login(app, { password: GOOD }));
    await confirm(app, { cookie, password: BAD, ip: "10.0.0.9" });
    const [entry] = bed.events("auth_login_failed");
    expect(entry).toMatchObject({ level: "warn", ip: "10.0.0.9", retryAfterMs: 1000 });
    expect(bed.lines.join("")).not.toContain(BAD);
    expect(bed.audited).toEqual([]);
    await bed.clock.advance(1000);
    await confirm(app, { cookie, password: GOOD });
    const userId = auth.authenticateCookieHeader(cookie)?.userId ?? "";
    expect(bed.audited).toEqual([{ ownerId: userId, actor: "user", kind: "auth", reason: "step_up" }]);
  });

  it("answers 401 to a confirm sent after the session signed out, and marks and audits nothing", async () => {
    const { app, auth } = await authBed();
    const cookie = sessionCookieOf(await login(app, { password: GOOD }));
    const pending = confirm(app, { cookie, password: GOOD });
    await logout(app, cookie);
    expect((await pending).status).toBe(401);
    expect(auth.authenticateCookieHeader(cookie)).toBeNull();
    expect(bed.audited).toEqual([]);
  });
});
