import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  begin,
  call,
  cookieOf,
  counterOf,
  enroll,
  fixed,
  ownerCookie,
  passkeyCount,
  signIn,
  startDaemon,
  verifyLogin,
} from "./testing/ceremony.ts";
import { createAuthTestBed, type AuthTestBed } from "./testing/fixture.ts";
import { createSoftwareAuthenticator } from "./testing/software-authenticator.ts";

// Real @simplewebauthn/server verification behind the real routes; only the authenticator is simulated.
const SECURE = "https://pap.example.net";

let bed: AuthTestBed;
beforeEach(() => {
  bed = createAuthTestBed();
});
afterEach(() => {
  bed.dispose();
});

describe("passkey ceremonies against the real verifier", () => {
  it("enrolls while signed in, then signs in with the passkey alone on a brand-new session", async () => {
    const daemon = startDaemon(bed);
    const first = await ownerCookie(daemon);
    expect((await enroll(daemon, first)).status).toBe(200);
    expect(bed.db.get("SELECT * FROM passkeys")).toMatchObject({ user_id: expect.any(String), counter: 0 });
    await call(daemon, "/auth/logout", {}, first);
    expect(daemon.auth.authenticateCookieHeader(first)).toBeNull();

    const planted = "pap_session=planted-by-an-attacker";
    const result = await signIn(daemon, undefined, planted);
    expect(result.status).toBe(200);
    const session = cookieOf(result.setCookie);
    expect(session).toMatch(/^pap_session=[\w-]{43,}$/);
    expect([session, first]).not.toContain(planted);
    expect(session).not.toBe(first);
    for (const attribute of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=2592000"]) {
      expect(result.setCookie).toContain(attribute);
    }
    expect(result.setCookie).not.toContain("Secure");
    const status = await daemon.app.request(new URL("/auth/status", daemon.origin).href, {
      headers: { cookie: session },
    });
    expect(await status.json()).toMatchObject({ authenticated: true, username: "owner" });
    expect(daemon.auth.authenticateCookieHeader(planted)).toBeNull();
    expect(counterOf(daemon)).toBe(1);
  });

  it("sets Secure on the sign-in cookie when the public origin is https", async () => {
    const daemon = startDaemon(bed, SECURE);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const result = await signIn(daemon);
    expect(result.status).toBe(200);
    expect(result.setCookie).toContain("Secure");
    expect(result.setCookie).toContain("HttpOnly");
  });

  it("registers nothing for a caller without a session, and a flow works once", async () => {
    const daemon = startDaemon(bed);
    const cookie = await ownerCookie(daemon);
    const { flowId, options } = await begin(daemon, "register", cookie);
    const response = daemon.authenticator.create(options);
    const anonymous = await call(daemon, "/auth/passkey/register/verify", { flowId, response });
    expect([anonymous.status, anonymous.body]).toEqual([401, fixed("unauthenticated")]);
    const forged = await call(daemon, "/auth/passkey/register/verify", { flowId, response }, "pap_session=x");
    expect(forged.status).toBe(401);
    expect(passkeyCount(daemon)).toBe(0);
    // Those never reached the flow: it is bound to the signed-in user and works once.
    const verify = () => call(daemon, "/auth/passkey/register/verify", { flowId, response }, cookie);
    expect((await verify()).status).toBe(200);
    expect((await verify()).status).toBe(401);
    expect(passkeyCount(daemon)).toBe(1);
  });

  it("logs the enrollment with the address only, never the username or the credential id", async () => {
    const daemon = startDaemon(bed);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const [entry] = bed.events("auth_passkey_enrolled");
    expect(Object.keys(entry ?? {}).sort()).toEqual(["ip", "level", "module", "msg", "time"]);
    expect(entry).toMatchObject({ level: "info", ip: "unknown" });
    const line = JSON.stringify(entry);
    expect(line).not.toContain(daemon.authenticator.credentialId);
    expect(line).not.toContain("owner");
  });

  it("refuses to enroll an authenticator that did not verify the user", async () => {
    const daemon = startDaemon(bed);
    const failed = await enroll(daemon, await ownerCookie(daemon), { userVerified: false });
    expect([failed.status, failed.body]).toEqual([401, fixed("unauthenticated")]);
    expect(passkeyCount(daemon)).toBe(0);
    expect(bed.events("auth_passkey_failed")).toHaveLength(1);
    expect(bed.events("auth_passkey_enrolled")).toEqual([]);
  });

  it("refuses a sign-in whose assertion lacks user verification, even with a valid signature", async () => {
    const daemon = startDaemon(bed);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const result = await signIn(daemon, { userVerified: false });
    expect([result.status, result.body, result.setCookie]).toEqual([401, fixed("unauthenticated"), ""]);
    expect(counterOf(daemon)).toBe(0);
  });

  it("stores the counter and rejects an assertion that does not advance it", async () => {
    const daemon = startDaemon(bed);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    expect((await signIn(daemon)).status).toBe(200);
    expect((await signIn(daemon)).status).toBe(200);
    expect(counterOf(daemon)).toBe(2);
    for (const stale of [2, 1]) {
      const replay = await signIn(daemon, { counter: stale });
      expect([replay.status, replay.setCookie], `counter ${stale}`).toEqual([401, ""]);
      expect(counterOf(daemon)).toBe(2);
    }
    expect((await signIn(daemon, { counter: 9 })).status).toBe(200);
    expect(counterOf(daemon)).toBe(9);
  });

  it("accepts an authenticator that never counts (synced passkeys report 0)", async () => {
    const daemon = startDaemon(bed);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    expect((await signIn(daemon, { counter: 0 })).status).toBe(200);
    expect((await signIn(daemon, { counter: 0 })).status).toBe(200);
    expect(counterOf(daemon)).toBe(0);
  });

  it("refuses a credential id that is already registered", async () => {
    const daemon = startDaemon(bed);
    const cookie = await ownerCookie(daemon);
    expect((await enroll(daemon, cookie)).status).toBe(200);
    const again = await enroll(daemon, cookie);
    expect([again.status, again.body]).toEqual([409, fixed("conflict")]);
    expect(passkeyCount(daemon)).toBe(1);
  });

  it("refuses a wrong origin (other host or other port), a wrong RP ID, a foreign challenge and a bad signature", async () => {
    const daemon = startDaemon(bed);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const wrong = [
      { origin: "http://evil.example" },
      { origin: "http://localhost:3000" },
      { rpId: "evil.example" },
    ];
    for (const overrides of wrong) {
      const result = await signIn(daemon, overrides);
      expect([result.status, result.setCookie], JSON.stringify(overrides)).toEqual([401, ""]);
    }
    await bed.clock.advance(61_000);
    const [mine, other] = [await begin(daemon, "login"), await begin(daemon, "login")];
    const foreign = daemon.authenticator.get(other.options);
    expect((await verifyLogin(daemon, mine.flowId, foreign)).status).toBe(401);

    await bed.clock.advance(61_000);
    const signed = await begin(daemon, "login");
    const response = daemon.authenticator.get(signed.options) as { response: { signature: string } };
    const bytes = Buffer.from(response.response.signature, "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    response.response.signature = bytes.toString("base64url");
    expect((await verifyLogin(daemon, signed.flowId, response)).status).toBe(401);
    expect(counterOf(daemon)).toBe(0);
  });

  it("backs off on repeated failures from one address and forgets them after a successful sign-in", async () => {
    const daemon = startDaemon(bed);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const evil = { origin: "http://evil.example" };
    expect((await signIn(daemon, evil)).status).toBe(401);
    expect((await signIn(daemon, evil)).status).toBe(401);
    expect((await signIn(daemon)).status).toBe(200);
    expect((await signIn(daemon, evil)).status).toBe(401);
    expect(bed.events("auth_passkey_failed").map((entry) => entry.retryAfterMs)).toEqual([1000, 2000, 1000]);
  });

  it("refuses an authenticator that was never enrolled", async () => {
    const daemon = startDaemon(bed);
    expect((await enroll(daemon, await ownerCookie(daemon))).status).toBe(200);
    const stranger = createSoftwareAuthenticator({ origin: daemon.origin, rpId: "localhost" });
    await bed.clock.advance(61_000);
    const { flowId, options } = await begin(daemon, "login");
    const result = await verifyLogin(daemon, flowId, stranger.get(options));
    expect([result.status, result.setCookie]).toEqual([401, ""]);
  });
});
