import { randomBytes } from "node:crypto";
import { PapError } from "@pap/contracts";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import { mountAuthRoutes } from "./http.ts";
import { createKnownDevices } from "./known-device.ts";
import { mountPasskeyRoutes } from "./passkey-http.ts";
import { createPasskeyService, type PasskeyService, type WebAuthnLib } from "./passkeys.ts";
import { createAuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createAuthTestBed, PASSWORD, type AuthTestBed } from "./testing/fixture.ts";
import { createThrottle } from "./throttle.ts";

const ORIGIN = "http://localhost:7777";
const GARBAGE = { flowId: "not-a-flow", response: { id: "AAAA" } };
const KNOWN = { flowId: "not-a-flow", response: { id: "cred-known" } };
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
  address = "10.0.0.9",
) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    socketAt(address),
  );
const cookieLine = (response: Response, name: string): string | undefined =>
  response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const valueOf = (line: string | undefined): string => (line ?? "").split(";")[0]?.split("=")[1] ?? "";

/** The real auth service and routes over the bed's database; the passkey service is whatever the test brings. */
async function routes(makePasskeys: (service: ReturnType<typeof createAuthService>) => PasskeyService) {
  const store = createAuthStore(bed.db);
  const devices = createKnownDevices(randomBytes(32));
  const setupToken = createSetupToken(true);
  const service = createAuthService({
    store,
    clock: bed.clock,
    logger: bed.logger.child({ module: "auth" }),
    publicOrigin: ORIGIN,
    throttle: createThrottle(bed.clock, { whenFull: "refuse" }),
    sessionThrottle: createThrottle(bed.clock, { whenFull: "refuse" }),
    setupToken,
    audit: { append: () => undefined },
    devices,
  });
  const passkeys = makePasskeys(service);
  const app = createHttpApp({
    allowedOrigins: new Set([ORIGIN]),
    staticRoot: null,
    logger: bed.logger,
    mount: (a) => {
      mountAuthRoutes(a, { service, passkeysAvailable: true, secureByConfig: false });
      mountPasskeyRoutes(a, {
        passkeys,
        auth: service,
        devices,
        userOfPasskey: (id) => store.findPasskey(id)?.userId,
        throttle: createThrottle(bed.clock, { whenFull: "evict" }),
        logger: bed.logger,
        audit: { append: () => undefined },
      });
    },
    wsProbe: (c) => c.json({}),
  });
  const owner = await service.setup({
    token: setupToken.current() ?? "",
    username: "owner",
    password: PASSWORD,
    ip: "127.0.0.1",
    userAgent: undefined,
  });
  const userId = store.findUserByName("owner")?.id ?? "";
  store.insertPasskey({
    id: "cred-known",
    userId,
    publicKey: new Uint8Array([1]),
    counter: 0,
    transports: [],
    createdAt: bed.clock.now(),
  });
  bed.lines.length = 0;
  return { app, service, store, userId, owner, device: `pap_device=${owner.deviceCookie ?? ""}` };
}

const mocked = (overrides: Partial<PasskeyService>): PasskeyService =>
  ({ available: true, ...overrides }) as unknown as PasskeyService;

describe("passkey sign-in and a known device (RT-06)", () => {
  it("keeps the known browser signing in while failures from the shared proxy address hold the address key", async () => {
    const loginVerify = vi.fn(() => Promise.reject(new PapError("unauthenticated")));
    const { app, device } = await routes(() => mocked({ loginVerify }));
    const attempt = (body: unknown, headers: Record<string, string> = {}, address?: string) =>
      post(app, "/auth/passkey/login/verify", body, headers, address);
    expect((await attempt(GARBAGE)).status).toBe(401);
    expect((await attempt(GARBAGE)).status).toBe(429);
    expect((await attempt(KNOWN)).status).toBe(429);
    expect((await attempt(KNOWN, { cookie: device })).status).toBe(401);
    // Its own failure locks only itself, wherever it comes from; the address stays as it was.
    expect((await attempt(KNOWN, { cookie: device })).status).toBe(429);
    expect((await attempt(KNOWN, { cookie: device }, "10.0.0.77")).status).toBe(429);
    expect((await attempt(GARBAGE, {}, "10.0.0.77")).status).toBe(401);
  });

  it("falls back to the address key for a forged cookie, and for a credential that is nobody's", async () => {
    const loginVerify = vi.fn(() => Promise.reject(new PapError("unauthenticated")));
    const { app, device } = await routes(() => mocked({ loginVerify }));
    const attempt = (body: unknown, cookie: string) =>
      post(app, "/auth/passkey/login/verify", body, { cookie });
    expect((await attempt(GARBAGE, device)).status).toBe(401);
    expect((await attempt(KNOWN, `pap_device=${"A".repeat(43)}`)).status).toBe(429);
    expect((await attempt(KNOWN, "pap_device=%%%")).status).toBe(429);
    expect((await attempt({ flowId: "x", response: { id: 7 } }, device)).status).toBe(429);
  });

  it("sets the device cookie on a passkey sign-in that had none, and not when a valid one came along", async () => {
    let ownerId = "";
    const loginVerify = vi.fn(() => Promise.resolve({ userId: ownerId, passkeyRef: "p".repeat(32) }));
    const { app, userId, device } = await routes(() => mocked({ loginVerify }));
    ownerId = userId;
    const bare = await post(app, "/auth/passkey/login/verify", KNOWN, {}, "10.0.0.5");
    expect(bare.status).toBe(200);
    expect(valueOf(cookieLine(bare, "pap_device"))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookieLine(bare, "pap_device")).toContain("Path=/auth");
    expect(cookieLine(bare, "pap_session")).toBeDefined();
    const known = await post(app, "/auth/passkey/login/verify", KNOWN, { cookie: device }, "10.0.0.5");
    expect(known.status).toBe(200);
    expect(cookieLine(known, "pap_device")).toBeUndefined();
    expect(cookieLine(known, "pap_session")).toBeDefined();
  });
});

describe("enrollment flows and their throttle", () => {
  const stubLib = {
    generateRegistrationOptions: () => Promise.resolve({ challenge: "reg-challenge" }),
    verifyRegistrationResponse: () =>
      Promise.resolve({
        verified: true,
        registrationInfo: {
          credential: {
            id: "cred-new",
            publicKey: new Uint8Array([1]),
            counter: 0,
            transports: ["internal"],
          },
        },
      }),
  } as unknown as WebAuthnLib;

  it("finishes a flow only with the cookie of the session that started it", async () => {
    const { app, service, store, userId, owner } = await routes(() =>
      createPasskeyService({
        store: createAuthStore(bed.db),
        clock: bed.clock,
        publicOrigin: ORIGIN,
        allowedOrigins: new Set([ORIGIN]),
        lib: stubLib,
      }),
    );
    const other = service.startSession(userId, undefined, { ip: "10.0.0.2", method: "password" });
    const as = (cookieValue: string) => ({ cookie: `pap_session=${cookieValue}` });
    const options = async () => {
      const response = await post(
        app,
        "/auth/passkey/register/options",
        { password: PASSWORD },
        as(owner.cookieValue),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { flowId: string }).flowId;
    };
    const verify = (flowId: string, cookieValue: string) =>
      post(app, "/auth/passkey/register/verify", { flowId, response: { id: "cred-new" } }, as(cookieValue));

    const stolen = await options();
    const refused = await verify(stolen, other.cookieValue);
    expect([refused.status, await refused.json()]).toEqual([401, { error: { code: "unauthenticated" } }]);
    expect(store.findPasskey("cred-new")).toBeUndefined();
    // The attempt used the flow up, for its owner too.
    expect((await verify(stolen, owner.cookieValue)).status).toBe(401);
    expect(store.findPasskey("cred-new")).toBeUndefined();

    const mine = await options();
    await bed.clock.advance(1000);
    expect((await verify(mine, owner.cookieValue)).status).toBe(200);
    expect(store.findPasskey("cred-new")?.userId).toBe(userId);
  });

  it("clears the backoff when the credential is already registered: a conflict is not a guess", async () => {
    const registerVerify = vi.fn(() => Promise.reject(new PapError("conflict")));
    const { app, owner } = await routes(() => mocked({ registerVerify }));
    const verify = () =>
      post(app, "/auth/passkey/register/verify", GARBAGE, { cookie: `pap_session=${owner.cookieValue}` });
    for (let i = 0; i < 3; i++) {
      const response = await verify();
      expect([response.status, await response.json()]).toEqual([409, { error: { code: "conflict" } }]);
    }
    expect(registerVerify).toHaveBeenCalledTimes(3);
  });

  it("still doubles the wait after a guess that failed", async () => {
    const registerVerify = vi.fn(() => Promise.reject(new PapError("unauthenticated")));
    const { app, owner } = await routes(() => mocked({ registerVerify }));
    const verify = () =>
      post(app, "/auth/passkey/register/verify", GARBAGE, { cookie: `pap_session=${owner.cookieValue}` });
    expect((await verify()).status).toBe(401);
    expect((await verify()).status).toBe(429);
    expect(registerVerify).toHaveBeenCalledTimes(1);
  });
});
