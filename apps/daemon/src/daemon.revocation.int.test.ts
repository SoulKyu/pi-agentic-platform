import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
import { openDatabase } from "./kernel/db/database.ts";
import { CLOSE_UNAUTHENTICATED, KEEPALIVE_MS } from "./kernel/ws/ws-server.ts";
import { httpRequest } from "./testing/http-client.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

let clock: FakeClock;
let t: TestDaemon;
beforeEach(async () => {
  clock = createFakeClock();
  t = await startTestDaemon({ steps: [{ text: "hi" }] }, { deps: { clock } });
});
afterEach(async () => {
  await t.stop();
});

async function signOut(cookie: string): Promise<void> {
  const reply = await httpRequest(`${t.base}/auth/logout`, {
    method: "POST",
    headers: { origin: t.origin, cookie },
  });
  expect(reply.status).toBe(204);
}

describe("a socket does not outlive its session", () => {
  it("the next request after sign-out is answered unauthenticated and the socket closes with 4401", async () => {
    const cookie = await t.login();
    const client = await t.connect(cookie);
    expect(await client.call("system.ping", {})).toMatchObject({ ok: true });
    await signOut(cookie);
    expect(await client.call("system.ping", {})).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });
    expect(await client.closed).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("an idle socket is closed at the next keepalive tick after sign-out", async () => {
    const cookie = await t.login();
    const client = await t.connect(cookie);
    expect(await client.call("system.ping", {})).toMatchObject({ ok: true });
    await clock.advance(KEEPALIVE_MS);
    // Talking inside the window keeps the peer alive, so the tick re-checks the session instead of cutting the socket.
    expect(await client.call("system.ping", {})).toMatchObject({ ok: true });
    await signOut(cookie);
    await clock.advance(KEEPALIVE_MS);
    expect(await client.closed).toBe(CLOSE_UNAUTHENTICATED);
  });

  it("a keepalive tick alone never extends the session; a request does (R130)", async () => {
    const cookie = await t.login();
    const client = await t.connect(cookie);
    expect(await client.call("system.ping", {})).toMatchObject({ ok: true });
    const db = openDatabase(join(t.home, "state.db"));
    try {
      const expiry = () => db.get<{ e: number }>("SELECT expires_at AS e FROM auth_sessions")?.e ?? 0;
      // Two days of the session's life are gone: it is due to slide.
      db.run("UPDATE auth_sessions SET expires_at = expires_at - $gone", { gone: 2 * 24 * 3600 * 1000 });
      const aged = expiry();
      await clock.advance(KEEPALIVE_MS);
      expect(expiry()).toBe(aged);
      expect(await client.call("system.ping", {})).toMatchObject({ ok: true });
      expect(expiry()).toBeGreaterThan(aged);
    } finally {
      db.close();
    }
  });
});
