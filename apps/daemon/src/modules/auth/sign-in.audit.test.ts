import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import { mountAuthRoutes } from "./http.ts";
import { createKnownDevices } from "./known-device.ts";
import { mountPasskeyRoutes } from "./passkey-http.ts";
import type { PasskeyService } from "./passkeys.ts";
import { createAuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createAuthTestBed, PASSWORD, setupTokenOf, type AuthTestBed } from "./testing/fixture.ts";
import { createThrottle } from "./throttle.ts";

const ORIGIN = "http://localhost:7777";
const owner = { username: "owner", password: PASSWORD };
let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => {
  bed.dispose();
});

const socketAt = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
const post = (app: ReturnType<AuthTestBed["start"]>["app"], path: string, body: unknown, address: string) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    socketAt(address),
  );
const reasons = (reason: string) => bed.audited.filter((line) => line.reason === reason);

describe("sign-in audit (M5R45)", () => {
  it("records the owner's creation and the sign-in it opens, with the method and the address", async () => {
    const { auth, app } = bed.start(ORIGIN);
    const response = await post(app, "/auth/setup", { token: setupTokenOf(auth), ...owner }, "10.0.0.4");
    expect(response.status).toBe(201);
    const [created] = reasons("owner_created");
    expect(reasons("owner_created")).toHaveLength(1);
    expect(created).toMatchObject({ actor: "user", kind: "auth" });
    expect(reasons("signed_in")).toEqual([
      expect.objectContaining({
        ownerId: created?.ownerId,
        actor: "user",
        kind: "auth",
        detail: { method: "setup", ip: "10.0.0.4" },
      }),
    ]);
  });

  it("an HTTP login leaves one signed_in row; a refused one leaves none", async () => {
    const { auth, app } = bed.start(ORIGIN);
    await post(app, "/auth/setup", { token: setupTokenOf(auth), ...owner }, "10.0.0.4");
    bed.audited.length = 0;
    const refused = await post(app, "/auth/login", { username: "nobody", password: PASSWORD }, "10.0.0.9");
    expect(refused.status).toBe(401);
    expect(reasons("signed_in")).toHaveLength(0);
    expect((await post(app, "/auth/login", owner, "10.0.0.8")).status).toBe(200);
    expect(reasons("signed_in")).toEqual([
      expect.objectContaining({ detail: { method: "password", ip: "10.0.0.8" } }),
    ]);
  });

  it("a passkey login leaves one signed_in row naming the method", async () => {
    const store = createAuthStore(bed.db);
    const devices = createKnownDevices(randomBytes(32));
    const service = createAuthService({
      store,
      clock: bed.clock,
      logger: bed.logger,
      publicOrigin: ORIGIN,
      throttle: createThrottle(bed.clock, { whenFull: "refuse" }),
      sessionThrottle: createThrottle(bed.clock, { whenFull: "refuse" }),
      setupToken: createSetupToken(true),
      audit: { append: (line) => void bed.audited.push(line) },
      devices,
    });
    const ownerId = "owner-1";
    store.insertFirstUser({ id: ownerId, username: "owner", passwordHash: "x", createdAt: bed.clock.now() });
    const loginVerify = vi.fn(() => Promise.resolve({ userId: ownerId, passkeyRef: "p".repeat(32) }));
    const passkeys = { available: true, loginVerify } as unknown as PasskeyService;
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
          userOfPasskey: () => ownerId,
          throttle: createThrottle(bed.clock, { whenFull: "evict" }),
          logger: bed.logger,
          audit: { append: (line) => void bed.audited.push(line) },
        });
      },
      wsProbe: (c) => c.json({}),
    });
    bed.audited.length = 0;
    const response = await post(
      app,
      "/auth/passkey/login/verify",
      { flowId: "f", response: { id: "cred" } },
      "10.0.0.6",
    );
    expect(response.status).toBe(200);
    expect(reasons("signed_in")).toEqual([
      expect.objectContaining({ ownerId, detail: { method: "passkey", ip: "10.0.0.6" } }),
    ]);
  });
});
