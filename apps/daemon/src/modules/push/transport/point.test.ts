import { createECDH, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authSecretOf, validPublicPoint } from "./point.ts";

const browserStyleKey = (): string => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]).toString("base64url");
};

describe("validPublicPoint", () => {
  it("passes 100 real P-256 keys (generateKeyPair)", () => {
    for (let i = 0; i < 100; i += 1) expect(validPublicPoint(browserStyleKey())).toBe(true);
  });

  it("passes an uncompressed key from createECDH, the shape pushManager.subscribe returns", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const key = ecdh.getPublicKey().toString("base64url");
    expect(key).toHaveLength(87);
    expect(validPublicPoint(key)).toBe(true);
  });

  it("refuses an off-curve point with a 4 prefix", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(validPublicPoint(Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"))).toBe(
        false,
      );
    }
  });

  it("refuses the all-zero point", () => {
    expect(validPublicPoint(Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"))).toBe(
      false,
    );
  });

  it("refuses a compressed key (33 bytes)", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    expect(validPublicPoint(ecdh.getPublicKey(undefined, "compressed").toString("base64url"))).toBe(false);
  });

  it("refuses a wrong prefix on a real point", () => {
    const raw = Buffer.from(browserStyleKey(), "base64url");
    raw[0] = 2;
    expect(validPublicPoint(raw.toString("base64url"))).toBe(false);
  });

  it("refuses 86 and 88 characters and non-base64url text", () => {
    const key = browserStyleKey();
    expect(validPublicPoint(key.slice(0, 86))).toBe(false);
    expect(validPublicPoint(`${key}A`)).toBe(false);
    expect(validPublicPoint(`${key.slice(0, 86)}=`)).toBe(false);
    expect(validPublicPoint(`${key.slice(0, 86)}+`)).toBe(false);
    expect(validPublicPoint("")).toBe(false);
  });
});

describe("authSecretOf", () => {
  it("accepts 16 bytes only", () => {
    expect(authSecretOf(randomBytes(16).toString("base64url"))?.length).toBe(16);
    expect(authSecretOf(randomBytes(15).toString("base64url"))).toBeNull();
    expect(authSecretOf(randomBytes(17).toString("base64url"))).toBeNull();
    expect(authSecretOf("")).toBeNull();
  });

  it("is strict base64url: padding, the standard alphabet and stray characters are refused", () => {
    const bytes = randomBytes(16);
    const plain = bytes.toString("base64");
    expect(plain.endsWith("==")).toBe(true);
    expect(authSecretOf(plain)).toBeNull();
    expect(authSecretOf(bytes.toString("base64url") + "==")).toBeNull();
    expect(authSecretOf(`${bytes.toString("base64url").slice(0, 21)}+`)).toBeNull();
    expect(authSecretOf(`${bytes.toString("base64url").slice(0, 21)}/`)).toBeNull();
    expect(authSecretOf(`${bytes.toString("base64url").slice(0, 21)} `)).toBeNull();
    expect(authSecretOf(bytes.toString("base64url"))?.equals(bytes)).toBe(true);
  });
});
