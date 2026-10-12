import { createHmac, randomBytes } from "node:crypto";
import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createLoginChallenges } from "./login-challenge.ts";

const TTL = 5 * 60_000;
const KEY = Buffer.alloc(32, 7);
const clock = createFakeClock();

// The R82 wire format, written out independently of the implementation.
function byRuling(expiresAt: number, label = "pap-passkey-login", key = KEY): Buffer {
  const nonce = randomBytes(16);
  const expiry = Buffer.alloc(8);
  expiry.writeBigUInt64BE(BigInt(expiresAt));
  const mac = createHmac("sha256", key).update(label).update(nonce).update(expiry).digest();
  return Buffer.concat([nonce, expiry, mac]);
}

describe("login challenges", () => {
  const challenges = createLoginChallenges(clock, TTL, KEY);

  it("are nonce, expiry and an HMAC over a fixed label, nonce and expiry", () => {
    const issued = challenges.issue();
    expect(issued).toHaveLength(56);
    expect(issued.readBigUInt64BE(16)).toBe(BigInt(clock.now() + TTL));
    const expected = createHmac("sha256", KEY)
      .update("pap-passkey-login")
      .update(issued.subarray(0, 24))
      .digest();
    expect(issued.subarray(24)).toEqual(expected);
    expect(challenges.issue()).not.toEqual(issued);
  });

  it("accept one built by the ruling and refuse one with another label or key or a past expiry", () => {
    expect(() => challenges.take(byRuling(clock.now() + TTL).toString("base64url"))).not.toThrow();
    const wrong = [
      byRuling(clock.now() + TTL, "other-label"),
      byRuling(clock.now() + TTL, undefined, Buffer.alloc(32, 8)),
      byRuling(clock.now()),
      byRuling(clock.now() - 1),
    ];
    for (const challenge of wrong) {
      expect(() => challenges.take(challenge.toString("base64url"))).toThrow(PapError);
    }
  });

  it("are taken once", () => {
    const challenge = challenges.issue().toString("base64url");
    challenges.take(challenge);
    expect(() => challenges.take(challenge)).toThrow(PapError);
  });
});

describe("used nonces (R85)", () => {
  const MINUTE = 60_000;

  it("outlive their expiry by five minutes: a clock stepped back cannot replay one", async () => {
    const stepped = createFakeClock();
    const own = createLoginChallenges(stepped, TTL, KEY);
    const challenge = own.issue().toString("base64url");
    own.take(challenge);
    await stepped.advance(TTL + 4 * MINUTE);
    own.take(own.issue().toString("base64url")); // any later answer sweeps the table
    await stepped.advance(-(TTL + 2 * MINUTE)); // the challenge is valid again by the clock
    expect(() => own.take(challenge)).toThrow(new PapError("unauthenticated"));
  });

  it("are forgotten once expiry plus five minutes has passed", async () => {
    const stepped = createFakeClock();
    const own = createLoginChallenges(stepped, TTL, KEY);
    const challenge = own.issue().toString("base64url");
    own.take(challenge);
    await stepped.advance(TTL + 5 * MINUTE);
    own.take(own.issue().toString("base64url"));
    await stepped.advance(-(TTL + 5 * MINUTE));
    expect(() => own.take(challenge)).not.toThrow();
  });

  it("are held for 10 000 at most: a full table of live nonces refuses new answers and forgets none", async () => {
    const stepped = createFakeClock();
    const own = createLoginChallenges(stepped, TTL, KEY);
    const first = own.issue().toString("base64url");
    own.take(first);
    for (let i = 1; i < 10_000; i++) own.take(own.issue().toString("base64url"));
    const refused = new PapError("unauthenticated");
    expect(() => own.take(own.issue().toString("base64url"))).toThrow(refused);
    expect(() => own.take(first)).toThrow(refused);
    await stepped.advance(TTL + 5 * MINUTE);
    expect(() => own.take(own.issue().toString("base64url"))).not.toThrow();
  });
});
