import { randomBytes } from "node:crypto";
import { PapError } from "@pap/contracts";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpApp } from "../../kernel/http/app.ts";
import { mountAuthRoutes } from "./http.ts";
import { createKnownDevices } from "./known-device.ts";
import { mountPasskeyRoutes } from "./passkey-http.ts";
import type { PasskeyService } from "./passkeys.ts";
import { createAuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createAuthTestBed, PASSWORD, type AuthTestBed } from "./testing/fixture.ts";
import { createThrottle } from "./throttle.ts";

const ORIGIN = "http://localhost:7777";
const GARBAGE = { flowId: "not-a-flow", response: { id: "AAAA" } };
let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => {
  bed.dispose();
});

const events = (name: string) => bed.events(name);
const socketAt = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
const post = (app: Hono, path: string, body: unknown, env?: object) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

describe("sign-in failures are counted before the slow verification (R85)", () => {
  type Outcome = { userId: string; passkeyRef: string };
  async function slow() {
    const store = createAuthStore(bed.db);
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
    });
    const audited: unknown[] = [];
    const started = await service.setup({
      token: setupToken.current() ?? "",
      username: "owner",
      password: PASSWORD,
      ip: "127.0.0.1",
      userAgent: undefined,
    });
    const settle: Array<(outcome: Outcome | Error) => void> = [];
    const loginVerify = vi.fn(
      () =>
        new Promise<Outcome>((resolve, reject) => {
          settle.push((outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)));
        }),
    );
    const app = createHttpApp({
      allowedOrigins: new Set([ORIGIN]),
      staticRoot: null,
      logger: bed.logger,
      mount: (a) => {
        mountAuthRoutes(a, { service, passkeysAvailable: true, secureByConfig: false });
        mountPasskeyRoutes(a, {
          passkeys: {
            available: true,
            loginVerify,
            registerVerify: () => Promise.resolve(),
          } as unknown as PasskeyService,
          auth: service,
          devices: createKnownDevices(randomBytes(32)),
          userOfPasskey: () => undefined,
          throttle: createThrottle(bed.clock, { whenFull: "evict" }),
          logger: bed.logger,
          audit: { append: (line) => void audited.push(line) },
        });
      },
      wsProbe: (c) => c.json({}),
    });
    const attempt = () => post(app, "/auth/passkey/login/verify", GARBAGE, socketAt("10.0.0.9"));
    bed.lines.length = 0;
    const enroll = () =>
      app.request(
        "/auth/passkey/register/verify",
        {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            cookie: `pap_session=${started.cookieValue}`,
          },
          body: JSON.stringify(GARBAGE),
        },
        socketAt("10.0.0.9"),
      );
    return { attempt, enroll, audited, settle, loginVerify, userId: store.findUserByName("owner")?.id ?? "" };
  }
  const refusal = new PapError("unauthenticated");

  it("queues parallel guesses: the second is throttled while the first is still verifying", async () => {
    const { attempt, settle, loginVerify } = await slow();
    const first = attempt();
    await vi.waitFor(() => expect(loginVerify).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const second = await attempt();
    expect([second.status, await second.json()]).toEqual([429, { error: { code: "rate_limited" } }]);
    expect(loginVerify).toHaveBeenCalledTimes(1);
    settle[0]?.(refusal);
    expect((await first).status).toBe(401);
    expect(events("auth_passkey_failed").map((e) => e.retryAfterMs)).toEqual([1000]);
  });

  it("clears the count on a success, so the next failure starts again at the first delay", async () => {
    const { attempt, settle, loginVerify, userId } = await slow();
    const failed = attempt();
    await vi.waitFor(() => expect(loginVerify).toHaveBeenCalledTimes(1), { timeout: 2000 });
    settle[0]?.(refusal);
    expect((await failed).status).toBe(401);
    await bed.clock.advance(1000);
    const good = attempt();
    await vi.waitFor(() => expect(loginVerify).toHaveBeenCalledTimes(2), { timeout: 2000 });
    settle[1]?.({ userId, passkeyRef: "p".repeat(32) });
    expect((await good).status).toBe(200);
    const again = attempt();
    await vi.waitFor(() => expect(loginVerify).toHaveBeenCalledTimes(3), { timeout: 2000 });
    settle[2]?.(refusal);
    expect((await again).status).toBe(401);
    expect(events("auth_passkey_failed").map((e) => e.retryAfterMs)).toEqual([1000, 1000]);
  });

  it("audits an enrollment with its owner and nothing else (M5R45)", async () => {
    const { enroll, audited, userId } = await slow();
    expect((await enroll()).status).toBe(200);
    expect(audited).toEqual([{ ownerId: userId, actor: "user", kind: "auth", reason: "passkey_enrolled" }]);
  });
});
