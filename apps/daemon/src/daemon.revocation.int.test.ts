import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
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
});
