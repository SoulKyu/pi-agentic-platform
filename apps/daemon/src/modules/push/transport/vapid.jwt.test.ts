import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { createLogger } from "../../../kernel/logger.ts";
import { loadVapid, type VapidIdentity } from "./vapid.ts";

const AUD = "https://push.example";
const SUB = "https://pap.example.net";
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
let dir = "";
let identity: VapidIdentity;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-vapid-jwt-"));
  const state = loadVapid(dir, createLogger({ level: "debug", clock: createFakeClock(), write: () => {} }));
  if (state.kind !== "ready") throw new Error("expected ready");
  identity = state.identity;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const parts = (header: string) => {
  const [t = "", k = ""] = header.split(", ");
  const [head = "", body = "", sig = ""] = t.slice(2).split(".");
  return {
    k,
    head,
    body,
    sig: Buffer.from(sig, "base64url"),
    claims: JSON.parse(Buffer.from(body, "base64url").toString()) as {
      aud: string;
      exp: number;
      sub: string;
    },
  };
};
const verifies = (header: string) => {
  const { head, body, sig } = parts(header);
  const point = Buffer.from(identity.publicKey, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  return verify("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" }, sig);
};

describe("VAPID Authorization (RFC 8292) and its per-audience cache (M12R5)", () => {
  it("aud is the push service origin, exp is within 24 h, the signature is raw r||s of 64 bytes", () => {
    const header = identity.sign(AUD, SUB, T0);
    const { claims, sig, k } = parts(header);
    expect(claims.aud).toBe(AUD);
    expect(claims.sub).toBe(SUB);
    expect(claims.exp).toBeGreaterThan(T0 / 1000);
    expect(claims.exp - T0 / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(sig).toHaveLength(64);
    expect(k).toBe(`k=${identity.publicKey}`);
    expect(header).toMatch(/^t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/); // ", " for interop with push services
    expect(verifies(header)).toBe(true);
  });

  it("the same audience reuses the token for 6 h, then signs a fresh one", () => {
    const first = identity.sign(AUD, SUB, T0);
    expect(identity.sign(AUD, SUB, T0 + 5 * HOUR + 59 * 60_000)).toBe(first);
    const later = identity.sign(AUD, SUB, T0 + 6 * HOUR);
    expect(later).not.toBe(first);
    expect(parts(later).claims.exp).toBe((T0 + 6 * HOUR) / 1000 + 12 * 3600);
    expect(verifies(later)).toBe(true);
  });

  it("a cached token always has at least 6 h of life left", () => {
    const first = identity.sign(AUD, SUB, T0);
    const nearEnd = T0 + 6 * HOUR - 1;
    expect(parts(first).claims.exp * 1000 - nearEnd).toBeGreaterThanOrEqual(6 * HOUR);
  });

  it("another audience gets its own token and never the first one's", () => {
    const a = identity.sign(AUD, SUB, T0);
    const b = identity.sign("https://other.example", SUB, T0);
    expect(parts(b).claims.aud).toBe("https://other.example");
    expect(a).not.toBe(b);
    expect(identity.sign(AUD, SUB, T0)).toBe(a);
  });

  it("a different subject is not served from the cache", () => {
    const a = identity.sign(AUD, SUB, T0);
    const b = identity.sign(AUD, "mailto:owner@pap.example", T0);
    expect(parts(b).claims.sub).toBe("mailto:owner@pap.example");
    expect(parts(a).claims.sub).toBe(SUB);
  });

  it("a clock that goes backwards does not reuse a token from the future", () => {
    const first = identity.sign(AUD, SUB, T0);
    const earlier = identity.sign(AUD, SUB, T0 - HOUR);
    expect(earlier).not.toBe(first);
    expect(parts(earlier).claims.exp).toBe((T0 - HOUR) / 1000 + 12 * 3600);
  });

  it("the cache is bounded: many audiences never grow it past its cap and stay correct", () => {
    for (let i = 0; i < 200; i += 1) {
      const aud = `https://p${i}.example`;
      expect(parts(identity.sign(aud, SUB, T0)).claims.aud).toBe(aud);
    }
    expect(parts(identity.sign(AUD, SUB, T0)).claims.aud).toBe(AUD);
  });

  it("the cache holds 32 entries: the 33rd distinct key clears it, so the first is signed again", () => {
    const first = identity.sign("https://p0.example", SUB, T0);
    for (let i = 1; i < 32; i += 1) identity.sign(`https://p${i}.example`, SUB, T0);
    expect(identity.sign("https://p0.example", SUB, T0), "32 entries still fit").toBe(first);
    identity.sign("https://p32.example", SUB, T0);
    const again = identity.sign("https://p0.example", SUB, T0);
    expect(again).not.toBe(first);
    expect(verifies(again)).toBe(true);
  });
});
