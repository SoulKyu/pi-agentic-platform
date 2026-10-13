import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthModule } from "./index.ts";
import { createAuthTestBed, PASSWORD, setupTokenOf, type AuthTestBed } from "./testing/fixture.ts";

const ORIGIN = "http://localhost:7777";
const GOOD = PASSWORD;
const BAD = "wrong password!!";
const OWNER_ADDRESS = "10.0.0.1";
const DEVICE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => {
  bed.dispose();
});

const socketAt = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
const post = (
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  ip = OWNER_ADDRESS,
  origin = ORIGIN,
) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    socketAt(ip),
  );
const login = (app: Hono, input: { password: string; ip?: string; cookie?: string; username?: string }) =>
  post(
    app,
    "/auth/login",
    { username: input.username ?? "owner", password: input.password },
    input.cookie ? { cookie: input.cookie } : {},
    input.ip,
  );
const confirm = (app: Hono, input: { cookie: string; password: string }) =>
  post(app, "/auth/confirm", { password: input.password }, { cookie: input.cookie });
const enrollOptions = (app: Hono, input: { cookie: string; password: string }) =>
  post(app, "/auth/passkey/register/options", { password: input.password }, { cookie: input.cookie });
const setCookies = (response: Response): string[] => response.headers.getSetCookie();
const cookieLine = (response: Response, name: string): string | undefined =>
  setCookies(response).find((line) => line.startsWith(`${name}=`));
const deviceCookieOf = (response: Response): string =>
  (cookieLine(response, "pap_device") ?? "").split(";")[0]?.slice("pap_device=".length) ?? "";
const sessionCookieOf = (response: Response): string =>
  (cookieLine(response, "pap_session") ?? "").split(";")[0] ?? "";

async function authBed(
  origin = ORIGIN,
  insecureHttp = false,
): Promise<{ app: Hono; auth: AuthModule; setup: Response }> {
  const { auth, app } = bed.start(origin, new Set([origin]), insecureHttp);
  const setup = await post(
    app,
    "/auth/setup",
    { token: setupTokenOf(auth), username: "owner", password: GOOD },
    {},
    OWNER_ADDRESS,
    origin,
  );
  expect(setup.status).toBe(201);
  await bed.clock.advance(5000);
  return { app, auth, setup };
}

describe("the device cookie", () => {
  it("is set by setup, with the attributes of the ruling", async () => {
    const { setup } = await authBed();
    const line = cookieLine(setup, "pap_device") ?? "";
    expect(deviceCookieOf(setup)).toMatch(DEVICE_SHAPE);
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/auth", "Max-Age=34560000"]) {
      expect(line, attribute).toContain(attribute);
    }
    expect(line).not.toContain("Secure");
    expect(cookieLine(setup, "pap_session")).toContain("Path=/;");
  });

  it("is Secure by the session cookie's rule: on https, and not on plain http with --insecure-http", async () => {
    const https = await authBed("https://pap.example.net");
    expect(cookieLine(https.setup, "pap_device")).toContain("Secure");
    bed.dispose();
    bed = createAuthTestBed();
    const lan = await authBed("http://192.168.1.182:7777", true);
    expect(cookieLine(lan.setup, "pap_device")).not.toContain("Secure");
    expect(cookieLine(lan.setup, "pap_device")).toContain("HttpOnly");
  });

  it("is set by a sign-in that had none, and left alone when the request carried a valid one", async () => {
    const { app } = await authBed();
    const first = await login(app, { password: GOOD });
    const device = deviceCookieOf(first);
    expect(device).toMatch(DEVICE_SHAPE);
    const again = await login(app, { password: GOOD, cookie: `pap_device=${device}` });
    expect(again.status).toBe(200);
    expect(cookieLine(again, "pap_device")).toBeUndefined();
    expect(cookieLine(again, "pap_session")).toBeDefined();
    const forged = await login(app, { password: GOOD, cookie: `pap_device=${"A".repeat(43)}` });
    expect(deviceCookieOf(forged)).toMatch(DEVICE_SHAPE);
    expect(deviceCookieOf(forged)).not.toBe("A".repeat(43));
  });

  it("is not set by a failed sign-in", async () => {
    const { app } = await authBed();
    const failed = await login(app, { password: BAD });
    expect(failed.status).toBe(401);
    expect(setCookies(failed)).toEqual([]);
  });

  it("never signs anybody in: the right cookie with a wrong password is a plain 401", async () => {
    const { app } = await authBed();
    const device = deviceCookieOf(await login(app, { password: GOOD }));
    const wrong = await login(app, { password: BAD, cookie: `pap_device=${device}` });
    expect([wrong.status, await wrong.json()]).toEqual([401, { error: { code: "unauthenticated" } }]);
    expect(cookieLine(wrong, "pap_session")).toBeUndefined();
    const status = await app.request("/auth/status", { headers: { cookie: `pap_device=${device}` } });
    expect(await status.json()).toMatchObject({ authenticated: false });
  });
});

describe("a known device and the sign-in throttle", () => {
  it("keeps the owner's known browser signing in while the username is under attack (the auth.md denial of service)", async () => {
    const { app } = await authBed();
    const first = await login(app, { password: GOOD });
    const device = deviceCookieOf(first);
    expect(device).toMatch(DEVICE_SHAPE);
    for (let i = 0; i < 20; i++) await login(app, { password: BAD, ip: "198.51.100.7" });
    expect((await login(app, { password: GOOD, ip: "198.51.100.8" })).status).toBe(429);
    expect((await login(app, { password: GOOD, cookie: `pap_device=${device}` })).status).toBe(200);
  });

  it("keeps every route open to the owner's known browser while the username is under attack (all four routes, RT-06)", async () => {
    const { app } = await authBed();
    const first = await login(app, { password: GOOD });
    const device = deviceCookieOf(first);
    const session = sessionCookieOf(first);
    for (let i = 0; i < 20; i++) await login(app, { password: BAD, ip: "198.51.100.7" });
    expect((await login(app, { password: GOOD, cookie: `pap_device=${device}` })).status).toBe(200);
    expect((await confirm(app, { cookie: session, password: GOOD })).status).toBe(204);
    expect((await enrollOptions(app, { cookie: session, password: GOOD })).status).toBe(200);
  });

  it("locks only the known device on its own failures, doubling the wait", async () => {
    const { app } = await authBed();
    const device = deviceCookieOf(await login(app, { password: GOOD }));
    const own = `pap_device=${device}`;
    await login(app, { password: BAD, cookie: own });
    const locked = await login(app, { password: GOOD, cookie: own });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("1");
    expect((await login(app, { password: GOOD })).status).toBe(200);
    await bed.clock.advance(1000);
    await login(app, { password: BAD, cookie: own });
    await bed.clock.advance(1000);
    expect((await login(app, { password: GOOD, cookie: own })).status).toBe(429);
    await bed.clock.advance(1000);
    expect((await login(app, { password: GOOD, cookie: own })).status).toBe(200);
  });

  it("does not let a failure of the known device arm the address or account keys", async () => {
    const { app } = await authBed();
    const device = deviceCookieOf(await login(app, { password: GOOD }));
    await login(app, { password: BAD, cookie: `pap_device=${device}`, ip: "198.51.100.9" });
    expect((await login(app, { password: GOOD, ip: "198.51.100.9" })).status).toBe(200);
  });

  it("treats a forged cookie, a cookie of another key and an unknown name like no cookie, with the same answers", async () => {
    const { app } = await authBed();
    for (let i = 0; i < 3; i++) await login(app, { password: BAD, ip: "198.51.100.7" });
    const answer = async (response: Response) => [
      response.status,
      await response.json(),
      response.headers.get("retry-after"),
    ];
    const bare = await answer(await login(app, { password: GOOD }));
    expect(bare[0]).toBe(429);
    const forged = await answer(await login(app, { password: GOOD, cookie: `pap_device=${"A".repeat(43)}` }));
    const garbage = await answer(await login(app, { password: GOOD, cookie: "pap_device=%%%%" }));
    const truncated = await answer(await login(app, { password: GOOD, cookie: "pap_device=abc" }));
    expect([forged, garbage, truncated]).toEqual([bare, bare, bare]);
  });

  it("does not let a cookie issued for one account choose a key for another name", async () => {
    const { app } = await authBed();
    const device = deviceCookieOf(await login(app, { password: GOOD }));
    for (let i = 0; i < 3; i++) await login(app, { password: BAD, username: "nobody", ip: "198.51.100.7" });
    const other = await login(app, {
      password: GOOD,
      username: "nobody",
      cookie: `pap_device=${device}`,
      ip: "198.51.100.7",
    });
    expect(other.status).toBe(429);
  });

  it("takes the first pap_device value that validates: a cookie planted on a narrower path changes nothing", async () => {
    const { app } = await authBed();
    const device = deviceCookieOf(await login(app, { password: GOOD }));
    for (let i = 0; i < 20; i++) await login(app, { password: BAD, ip: "198.51.100.7" });
    const tossed = `pap_device=${"A".repeat(43)}; pap_device=junk; pap_device=${device}`;
    expect((await login(app, { password: GOOD, cookie: tossed })).status).toBe(200);
    expect((await login(app, { password: GOOD, cookie: `pap_device=${"A".repeat(43)}` })).status).toBe(429);
  });

  it("survives a restart: a second module on the same secrets directory honours the first one's cookie", async () => {
    const { app } = await authBed();
    const device = deviceCookieOf(await login(app, { password: GOOD }));
    for (let i = 0; i < 20; i++) await login(app, { password: BAD, ip: "198.51.100.7" });
    const second = bed.start(ORIGIN);
    expect((await login(second.app, { password: GOOD })).status).toBe(200);
    for (let i = 0; i < 20; i++) await login(second.app, { password: BAD, ip: "198.51.100.7" });
    expect((await login(second.app, { password: GOOD })).status).toBe(429);
    expect((await login(second.app, { password: GOOD, cookie: `pap_device=${device}` })).status).toBe(200);
  });
});
