import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { decryptAes128gcm, type PushSink, startPushSink } from "./push-sink.ts";

const b64u = (text: string): Buffer => Buffer.from(text, "base64url");
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

// RFC 8291 appendix A ("Message Encryption Example"), values as printed there. The daemon's push module is not imported
// (boundaries): the RFC's own message is the check that the sink reads what a push service forwards.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPrivate: b64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"),
  uaPublic: b64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  authSecret: b64u("BTBZMqHH6r4Tts7J_aSIgg"),
  body: b64u(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  ),
};

/** The application server's side (RFC 8291 section 3.3), for a user agent public key and secret. */
function encrypt(plaintext: string, uaPublic: Buffer, auth: Buffer): Buffer {
  const as = createECDH("prime256v1");
  const asPublic = as.generateKeys();
  const salt = randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(as.computeSecret(uaPublic), auth, keyInfo, 32);
  const key = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.of(2)])),
    cipher.final(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed, cipher.getAuthTag()]);
}

function post(url: string, path: string, body: Buffer, method = "POST"): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method, headers: { "content-encoding": "aes128gcm" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("decryptAes128gcm", () => {
  it("opens the message of RFC 8291 appendix A with the RFC's user agent key", () => {
    const ua = createECDH("prime256v1");
    ua.setPrivateKey(RFC.uaPrivate);
    expect(ua.getPublicKey().equals(RFC.uaPublic)).toBe(true);
    expect(decryptAes128gcm(RFC.body, ua, RFC.authSecret)).toBe(RFC.plaintext);
  });

  it("refuses a body whose tag was changed", () => {
    const ua = createECDH("prime256v1");
    ua.setPrivateKey(RFC.uaPrivate);
    const bent = Buffer.from(RFC.body);
    bent[bent.length - 1] = (bent[bent.length - 1] ?? 0) ^ 1;
    expect(() => decryptAes128gcm(bent, ua, RFC.authSecret)).toThrow();
  });
});

describe("startPushSink", () => {
  let sink: PushSink | undefined;
  afterEach(async () => {
    await sink?.close();
    sink = undefined;
  });

  it("listens on 127.0.0.1 only and keeps the POSTs of its push path, decrypting them with its own keys", async () => {
    sink = await startPushSink();
    expect(sink.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const sealed = encrypt("a sentence for the lock screen", b64u(sink.keys.p256dh), b64u(sink.keys.auth));
    expect(await post(sink.url, "/push/e2e", sealed)).toBe(201);
    const [hit, ...rest] = sink.received();
    expect(rest).toEqual([]);
    expect(hit?.path).toBe("/push/e2e");
    expect(hit?.headers["content-encoding"]).toBe("aes128gcm");
    expect(hit?.body.equals(sealed)).toBe(true);
    expect(hit && sink.keys.decrypt(hit)).toBe("a sentence for the lock screen");
  });

  it("keeps nothing from other paths or methods, and stops listening on close", async () => {
    sink = await startPushSink();
    const url = sink.url;
    expect(await post(url, "/elsewhere", Buffer.from("x"))).toBe(404);
    expect(await post(url, "/push/e2e", Buffer.from("x"), "PUT")).toBe(404);
    expect(sink.received()).toEqual([]);
    await sink.close();
    sink = undefined;
    await expect(post(url, "/push/e2e", Buffer.from("x"))).rejects.toThrow();
  });
});
