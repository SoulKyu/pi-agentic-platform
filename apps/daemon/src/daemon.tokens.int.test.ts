import { PROTOCOL_VERSION } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createSystemClock, type Clock } from "./kernel/clock.ts";
import { captureLogger } from "./testing/capture-logger.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import { httpRequest } from "./testing/http-client.ts";
import { connectTestClient, type TestClient } from "./testing/ws-client.ts";

const script = { steps: [{ text: "hi" }] };
const DAY_MS = 24 * 3600 * 1000;

async function mintToken(t: TestDaemon, cookie: string, owner: TestClient, permissions: string[]) {
  await t.confirmStepUp(cookie);
  const created = await owner.call("auth.tokens.create", {
    name: "ci",
    permissions: permissions as never,
    expiresInDays: 7,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  const { value, token } = created.result as { value: string; token: { id: string } };
  return { value, id: token.id };
}

describe("bearer tokens on /ws", () => {
  it("a token opens /ws without Origin, works within its permissions, and its socket closes when revoked", async () => {
    const t = await startTestDaemon(script);
    try {
      const cookie = await t.login();
      const owner = await t.connect(cookie);
      const { value, id } = await mintToken(t, cookie, owner, ["sessions:read", "audit:read"]);
      const bot = await t.connectBearer(value);
      expect(await bot.call("sessions.list", {})).toMatchObject({ ok: true });
      expect(await bot.call("sessions.create", { cwd: t.cwd })).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
      expect(await bot.call("auth.tokens.list", {})).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
      await owner.call("auth.tokens.revoke", { tokenId: id });
      expect(await bot.call("sessions.list", {})).toMatchObject({
        ok: false,
        error: { code: "unauthenticated" },
      });
      expect(await bot.closed).toBe(4401);
      await expect(t.connectBearer(value)).rejects.toThrow(/status 401/);
    } finally {
      await t.stop();
    }
  });

  it("refuses a token upgrade that carries a foreign Origin, and a cookie upgrade that carries none", async () => {
    const { logger, lines } = captureLogger();
    const t = await startTestDaemon(script, { deps: { logger } });
    try {
      const cookie = await t.login();
      const owner = await t.connect(cookie);
      const { value } = await mintToken(t, cookie, owner, ["sessions:read"]);
      await expect(t.connectBearer(value, "https://evil.test")).rejects.toThrow(/status 403/);
      await expect(
        connectTestClient(`ws://127.0.0.1:${t.port}/ws?proto=${PROTOCOL_VERSION}`, { cookie }),
      ).rejects.toThrow(/status 403/);
      await expect(
        connectTestClient(`ws://127.0.0.1:${t.port}/ws?proto=${PROTOCOL_VERSION}`, {
          cookie,
          authorization: `Bearer ${value}`,
          origin: t.origin,
        }),
      ).rejects.toThrow(/status 400/);
      // One line per kind (`via`) every 10 s (M1's limiter): the second refusal, also on `ws`, is counted, not logged.
      expect(lines.filter((line) => line.msg === "origin_refused").map((line) => line.origin)).toEqual([
        "https://evil.test",
      ]);
      expect(JSON.stringify(lines)).not.toContain(value);
    } finally {
      await t.stop();
    }
  });

  it("answers the GET /ws probe for a valid bearer, a revoked one, an expired one and a conflict", async () => {
    let skew = 0;
    const system = createSystemClock();
    const clock: Clock = { ...system, now: () => system.now() + skew };
    const t = await startTestDaemon(script, { deps: { clock } });
    try {
      const cookie = await t.login();
      const owner = await t.connect(cookie);
      const live = await mintToken(t, cookie, owner, ["sessions:read"]);
      const doomed = await mintToken(t, cookie, owner, ["sessions:read"]);
      const probe = (headers: Record<string, string>) =>
        httpRequest(`${t.base}/ws?proto=${PROTOCOL_VERSION}`, { headers }).then((reply) => reply.status);
      expect(await probe({ authorization: `Bearer ${live.value}` })).toBe(200);
      expect(await probe({ authorization: `Bearer ${live.value}`, cookie })).toBe(400);
      await owner.call("auth.tokens.revoke", { tokenId: doomed.id });
      expect(await probe({ authorization: `Bearer ${doomed.value}` })).toBe(401);
      skew = 8 * DAY_MS;
      expect(await probe({ authorization: `Bearer ${live.value}` })).toBe(401);
    } finally {
      await t.stop();
    }
  });
});
