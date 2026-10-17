import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPayload } from "../testing/decrypt.ts";
import { encryptPayload } from "./encrypt.ts";

const b64u = (s: string) => Buffer.from(s, "base64url");
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

/*
 * RFC 8291 section 5 ("Message Encryption Example"), the full example. Values as printed there (base64url), entered
 * without network access: the body reproduced byte for byte and the RFC body opened by the RFC's user-agent key are
 * the checks that they are right. Only the final body is pinned; the intermediate values (secret, PRK, CEK, nonce)
 * are not asserted on their own.
 */
const VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: b64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  asPublic: b64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"),
  uaPrivate: b64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  uaPublic: b64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  authSecret: b64u("BTBZMqHH6r4Tts7J_aSIgg"),
  salt: b64u("DGv6ra1nlYgDCS1FRnbzlw"),
  body: b64u(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  ),
};

const uaKeys = () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  return { ua, auth: randomBytes(16) };
};

describe("encryptPayload", () => {
  it("rfc8291-section-5-vector: the body equals the RFC's bytes", () => {
    const body = encryptPayload(Buffer.from(VECTOR.plaintext), VECTOR.uaPublic, VECTOR.authSecret, {
      asPrivate: VECTOR.asPrivate,
      salt: VECTOR.salt,
    });
    expect(body.toString("hex")).toBe(VECTOR.body.toString("hex"));
    expect(body.equals(VECTOR.body)).toBe(true);
  });

  it("the RFC's own body decrypts with the RFC's user-agent key", () => {
    const ua = createECDH("prime256v1");
    ua.setPrivateKey(VECTOR.uaPrivate);
    expect(ua.getPublicKey().equals(VECTOR.uaPublic)).toBe(true);
    expect(decryptPayload(VECTOR.body, ua, VECTOR.authSecret).toString()).toBe(VECTOR.plaintext);
  });

  it("header layout: salt, record size 4096, key id length 65, then the server key", () => {
    const { ua, auth } = uaKeys();
    const body = encryptPayload(Buffer.from("x"), ua.getPublicKey(), auth);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(4);
    expect(body).toHaveLength(21 + 65 + 1 + 1 + 16);
  });

  it.each([0, 1, 100, 3993])("roundtrip of %i bytes", (size) => {
    const { ua, auth } = uaKeys();
    const plaintext = randomBytes(size);
    const body = encryptPayload(plaintext, ua.getPublicKey(), auth);
    expect(body).toHaveLength(86 + size + 1 + 16);
    expect(decryptPayload(body, ua, auth).equals(plaintext)).toBe(true);
  });

  it("3994 bytes throw RangeError payload_too_large", () => {
    const { ua, auth } = uaKeys();
    expect(() => encryptPayload(randomBytes(3994), ua.getPublicKey(), auth)).toThrow(RangeError);
    expect(() => encryptPayload(randomBytes(3994), ua.getPublicKey(), auth)).toThrow("payload_too_large");
  });

  it("fresh-key-and-salt-each-call", () => {
    const { ua, auth } = uaKeys();
    const a = encryptPayload(Buffer.from("same"), ua.getPublicKey(), auth);
    const b = encryptPayload(Buffer.from("same"), ua.getPublicKey(), auth);
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false);
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("rejects-bad-keys", () => {
    const { ua, auth } = uaKeys();
    const good = ua.getPublicKey();
    const plaintext = Buffer.from("x");
    expect(() => encryptPayload(plaintext, good.subarray(0, 64), auth)).toThrow(RangeError);
    const wrongPrefix = Buffer.from(good);
    wrongPrefix[0] = 2;
    expect(() => encryptPayload(plaintext, wrongPrefix, auth)).toThrow("bad_keys");
    expect(() => encryptPayload(plaintext, good, auth.subarray(0, 15))).toThrow(RangeError);
    expect(() => encryptPayload(plaintext, good, Buffer.concat([auth, auth]))).toThrow(RangeError);
  });

  it("an off-curve user-agent key throws RangeError bad_keys exactly, never a raw crypto error, and yields no body", () => {
    const { auth } = uaKeys();
    const offCurve = Buffer.concat([Buffer.from([4]), randomBytes(64)]);
    let caught: unknown = null;
    try {
      encryptPayload(Buffer.from("x"), offCurve, auth);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as RangeError).message).toBe("bad_keys");
  });

  it("tamper: one flipped byte of the record fails the GCM tag", () => {
    const { ua, auth } = uaKeys();
    const body = encryptPayload(Buffer.from("secret text"), ua.getPublicKey(), auth);
    for (const at of [86, body.length - 1]) {
      const bad = Buffer.from(body);
      bad[at] = (bad[at] ?? 0) ^ 1;
      expect(() => decryptPayload(bad, ua, auth)).toThrow();
    }
  });

  it("a different auth secret does not decrypt", () => {
    const { ua, auth } = uaKeys();
    const body = encryptPayload(Buffer.from("x"), ua.getPublicKey(), auth);
    expect(() => decryptPayload(body, ua, randomBytes(16))).toThrow();
  });

  it("the decryptor refuses a record that is too short to hold a header", () => {
    const { ua, auth } = uaKeys();
    expect(() => decryptPayload(Buffer.alloc(40), ua, auth)).toThrow("short_body");
  });

  it("bad_delimiter: a valid record whose last byte is 0x01 (or all padding) is refused, 0x02 opens", () => {
    const { ua, auth } = uaKeys();
    const sealed = (delimiter: number, text: string) => {
      const as = createECDH("prime256v1");
      as.generateKeys();
      const uaPublic = ua.getPublicKey();
      const salt = randomBytes(16);
      const prk = hkdf(
        as.computeSecret(uaPublic),
        auth,
        Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, as.getPublicKey()]),
        32,
      );
      const cipher = createCipheriv(
        "aes-128-gcm",
        hkdf(prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
        hkdf(prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
      );
      const record = Buffer.concat([
        cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([delimiter])])),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      const head = Buffer.alloc(21);
      salt.copy(head, 0);
      head.writeUInt32BE(4096, 16);
      head.writeUInt8(65, 20);
      return Buffer.concat([head, as.getPublicKey(), record]);
    };
    expect(decryptPayload(sealed(2, "ok"), ua, auth).toString()).toBe("ok");
    expect(() => decryptPayload(sealed(1, "ok"), ua, auth)).toThrow("bad_delimiter");
    expect(() => decryptPayload(sealed(0, ""), ua, auth)).toThrow("bad_delimiter");
  });
});
