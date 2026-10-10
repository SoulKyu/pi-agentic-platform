import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  begin,
  call,
  counterOf,
  enroll,
  fixed,
  ownerCookie,
  signIn,
  startDaemon,
  verifyLogin,
  type Daemon,
} from "./testing/ceremony.ts";
import { createAuthTestBed, type AuthTestBed } from "./testing/fixture.ts";
import { createSoftwareAuthenticator } from "./testing/software-authenticator.ts";

// R82: sign-in challenges carry their own proof (HMAC, expiry, nonce), so the server keeps nothing per
// issued challenge. These run the real verifier through the real routes.
const TTL = 5 * 60_000;
let bed: AuthTestBed;
let daemon: Daemon;
let owner: string;
beforeEach(async () => {
  bed = createAuthTestBed();
  daemon = startDaemon(bed);
  owner = await ownerCookie(daemon);
  expect((await enroll(daemon, owner)).status).toBe(200);
});
afterEach(() => {
  bed.dispose();
});

const answer = (challenge: string, flowId = challenge, overrides = {}) =>
  verifyLogin(daemon, flowId, daemon.authenticator.get({ challenge }, overrides));
const refused = (result: { status: number; setCookie: string }) => [result.status, result.setCookie];

describe("stateless sign-in challenges", () => {
  it("survive any number of other login options requests", async () => {
    const earlier = await begin(daemon, "login");
    for (let i = 0; i < 1000; i++) {
      expect((await call(daemon, "/auth/passkey/login/options")).status).toBe(200);
    }
    const result = await answer(earlier.options.challenge, earlier.flowId);
    expect(result.status).toBe(200);
    expect(result.setCookie).toContain("pap_session=");
  });

  it("are the flow id and are issued fresh each time", async () => {
    const [a, b] = [await begin(daemon, "login"), await begin(daemon, "login")];
    expect(a.flowId).toBe(a.options.challenge);
    expect(a.flowId).not.toBe(b.flowId);
    expect(a.flowId.length).toBeGreaterThan(64);
  });

  it("refuse a tampered challenge, a lengthened expiry and malformed ids", async () => {
    const { flowId } = await begin(daemon, "login");
    const bytes = Buffer.from(flowId, "base64url");
    const flipped = Buffer.from(bytes);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const lengthened = Buffer.from(bytes);
    lengthened.writeBigUInt64BE(lengthened.readBigUInt64BE(16) + 86_400_000n, 16);
    const wrongMac = Buffer.from(bytes);
    wrongMac[wrongMac.length - 1] = (wrongMac[wrongMac.length - 1] ?? 0) ^ 1;
    const candidates = [flipped, lengthened, wrongMac, bytes.subarray(0, 40)].map((b) =>
      b.toString("base64url"),
    );
    // The last character carries two bits a lenient decoder drops: same bytes, different spelling.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const respelled = flowId.slice(0, -1) + alphabet[alphabet.indexOf(flowId.slice(-1)) ^ 1];
    expect(Buffer.from(respelled, "base64url")).toEqual(bytes);
    const attempts = [...candidates, respelled, "x", "!!!", `${flowId}A`, "A".repeat(100)];
    for (const [index, candidate] of attempts.entries()) {
      const result = await answer(candidate.slice(0, 120));
      expect(refused(result), candidate).toEqual([401, ""]);
      // Just the back-off these failures earned, so the genuine challenge below is still within its five minutes.
      await bed.clock.advance(1000 * Math.min(2 ** index, 60));
    }
    // None of those used up the genuine one.
    expect((await answer(flowId)).status).toBe(200);
  });

  it("expire after five minutes, not before", async () => {
    const early = await begin(daemon, "login");
    const late = await begin(daemon, "login");
    await bed.clock.advance(TTL - 1);
    expect((await answer(early.flowId)).status).toBe(200);
    await bed.clock.advance(2);
    expect(refused(await answer(late.flowId))).toEqual([401, ""]);
  });

  it("work once: a replay is refused even from an authenticator that never counts", async () => {
    const { flowId } = await begin(daemon, "login");
    expect((await answer(flowId, flowId, { counter: 0 })).status).toBe(200);
    await bed.clock.advance(61_000);
    expect(refused(await answer(flowId, flowId, { counter: 0 }))).toEqual([401, ""]);
  });

  it("are used up by a failed attempt too", async () => {
    const { flowId } = await begin(daemon, "login");
    expect(refused(await answer(flowId, flowId, { origin: "http://evil.example" }))).toEqual([401, ""]);
    await bed.clock.advance(61_000);
    expect(refused(await answer(flowId))).toEqual([401, ""]);
    expect(counterOf(daemon)).toBe(0);
  });

  it("do not survive a restart: a new process key refuses what the old one issued", async () => {
    const { flowId } = await begin(daemon, "login");
    const restarted: Daemon = { ...startDaemon(bed), authenticator: daemon.authenticator };
    await bed.clock.advance(61_000);
    const result = await verifyLogin(restarted, flowId, restarted.authenticator.get({ challenge: flowId }));
    expect([refused(result), result.body]).toEqual([[401, ""], fixed("unauthenticated")]);
    expect((await signIn(restarted)).status).toBe(200);
  });
});

describe("what the authenticator reports", () => {
  it("must name the credential's own user when it names one", async () => {
    const other = Buffer.from("someone-else").toString("base64url");
    expect(refused(await signIn(daemon, { userHandle: other }))).toEqual([401, ""]);
    expect(counterOf(daemon)).toBe(0);
    expect((await signIn(daemon, { userHandle: null })).status).toBe(200);
    expect((await signIn(daemon)).status).toBe(200);
  });

  it("keeps only known transports, whatever the registration response claims", async () => {
    const stored = (authenticator: Daemon["authenticator"]) =>
      bed.db.get<{ transports: string }>("SELECT transports FROM passkeys WHERE id = $id", {
        id: authenticator.credentialId,
      })?.transports;
    const claims = [
      [["usb", "javascript:alert(1)", 7, null, "internal"], '["usb","internal"]'],
      ["usb", "[]"],
      [{ 0: "usb" }, "[]"],
    ] as const;
    for (const [claimed, expected] of claims) {
      const authenticator = createSoftwareAuthenticator({ origin: daemon.origin, rpId: "localhost" });
      const extra = { ...daemon, authenticator };
      expect((await enroll(extra, owner, { transports: claimed })).status).toBe(200);
      expect(stored(extra.authenticator)).toBe(expected);
    }
  });
});
