import { PROTOCOL_VERSION } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureLogger } from "../testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { httpRequest } from "../testing/http-client.ts";
import { connectTestClient } from "../testing/ws-client.ts";

// Spec C §8.1, class "forged Origin", through the whole daemon (M5R70): a present Origin is checked first, a cookie
// without one is refused, a foreign Origin answers 403 and logs `origin_refused`.
const PASSWORD = "correct horse battery staple";
const forged = (t: TestDaemon) => [
  "https://evil.test",
  "null",
  `${t.origin}/`,
  t.origin.replace("localhost", "127.0.0.2"),
  t.origin.replace("http:", "https:"),
  `http://localhost:${t.port + 1}`,
];
const FLOW = { flowId: "x", response: {} };
// Every unsafe route, and a path nothing serves: the guard is global, so it answers before routing.
const UNSAFE_ROUTES = [
  ["/auth/login", { username: "owner", password: PASSWORD }],
  ["/auth/confirm", { password: PASSWORD }],
  ["/auth/logout", {}],
  ["/auth/passkey/login/options", {}],
  ["/auth/passkey/login/verify", FLOW],
  ["/auth/passkey/register/options", { password: PASSWORD }],
  ["/auth/passkey/register/verify", FLOW],
  ["/api/x", {}],
] as const;
const wsUrl = (t: TestDaemon) => `ws://127.0.0.1:${t.port}/ws?proto=${PROTOCOL_VERSION}`;

describe("security: forged Origin (daemon)", () => {
  const captured = captureLogger();
  let t: TestDaemon | undefined;
  let cookie = "";
  let bearer = "";
  const daemon = (): TestDaemon => {
    if (!t) throw new Error("the daemon did not start");
    return t;
  };

  beforeAll(async () => {
    t = await startTestDaemon({ steps: [{ text: "hi" }] }, { deps: { logger: captured.logger } });
    cookie = await t.login();
    await t.confirmStepUp(cookie);
    const owner = await t.connect(cookie);
    const created = await owner.call("auth.tokens.create", {
      name: "ci",
      permissions: ["sessions:read"],
      expiresInDays: 7,
    });
    if (!created.ok) throw new Error(`token create failed: ${created.error.code}`);
    bearer = (created.result as { value: string }).value;
    owner.close();
  });
  afterAll(async () => {
    await t?.stop();
  });

  const post = (path: string, body: object, headers: Record<string, string>) =>
    httpRequest(`${daemon().base}${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("refuses every unsafe route with a forged Origin, logs it, and changes nothing", async () => {
    for (const origin of forged(daemon())) {
      for (const [path, body] of UNSAFE_ROUTES) {
        const reply = await post(path, body, { origin, cookie });
        expect([origin, path, reply.status, reply.headers["set-cookie"]]).toEqual([
          origin,
          path,
          403,
          undefined,
        ]);
      }
    }
    // The first refusal of each kind is logged, with the Origin as sent; the window swallows the rest (R70).
    expect(captured.lines.filter((line) => line.msg === "origin_refused")).toMatchObject([
      { via: "http", origin: "https://evil.test", suppressed: 0 },
    ]);
    // The session a forged logout aimed at still works.
    const status = await httpRequest(`${daemon().base}/auth/status`, { headers: { cookie } });
    expect(JSON.parse(status.body)).toMatchObject({ authenticated: true });
    expect(JSON.stringify(captured.lines)).not.toContain(cookie.split("=")[1] ?? "no-cookie");
  });

  it("refuses every unsafe route that carries a cookie and no Origin at all", async () => {
    for (const [path, body] of UNSAFE_ROUTES) {
      const reply = await post(path, body, { cookie });
      expect([path, reply.status, reply.headers["set-cookie"]]).toEqual([path, 403, undefined]);
    }
  });

  it("refuses every unsafe route that carries a bearer token and a forged Origin, or none", async () => {
    for (const origin of [...forged(daemon()), undefined]) {
      for (const [path, body] of UNSAFE_ROUTES) {
        const reply = await post(path, body, {
          authorization: `Bearer ${bearer}`,
          ...(origin === undefined ? {} : { origin }),
        });
        expect([origin, path, reply.status]).toEqual([origin, path, 403]);
      }
    }
  });

  it("refuses the /ws upgrade with a forged Origin, for a cookie and for a bearer token", async () => {
    const t = daemon();
    for (const origin of forged(t)) {
      await expect(connectTestClient(wsUrl(t), { origin, cookie })).rejects.toThrow(/status 403/);
      await expect(t.connectBearer(bearer, origin)).rejects.toThrow(/status 403/);
    }
    await expect(connectTestClient(wsUrl(t), { cookie })).rejects.toThrow(/status 403/);
    // Without any Origin the token is accepted (ADR 0021).
    const bot = await t.connectBearer(bearer);
    expect(await bot.call("sessions.list", {})).toMatchObject({ ok: true });
    bot.close();
  });
});

describe("security: forged Origin before any owner exists", () => {
  it("refuses a setup with a forged Origin and the setup stays possible", async () => {
    const fresh = await startTestDaemon({ steps: [{ text: "hi" }] });
    try {
      const token = new URL(fresh.daemon.setupUrl ?? "http://invalid").hash.replace("#token=", "");
      const reply = await httpRequest(`${fresh.base}/auth/setup`, {
        method: "POST",
        headers: { origin: "https://evil.test", "content-type": "application/json" },
        body: JSON.stringify({ token, username: "owner", password: PASSWORD }),
      });
      expect(reply.status).toBe(403);
      expect(reply.headers["set-cookie"]).toBeUndefined();
      expect(JSON.parse((await httpRequest(`${fresh.base}/auth/status`, {})).body)).toMatchObject({
        setupRequired: true,
      });
      // The same token still works with the right Origin: the refusal consumed nothing.
      expect(await fresh.login()).toMatch(/^pap_session=/);
    } finally {
      await fresh.stop();
    }
  });
});
