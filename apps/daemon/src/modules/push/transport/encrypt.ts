import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

const RS = 4096;
const HEADER = 16 + 4 + 1 + 65; // salt, record size, key id length, the 65-byte server key
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

/**
 * RFC 8291 `aes128gcm` (RFC 8188, one record): the complete request body for a Web Push message. Only the transport
 * calls it (M12R6). The `injected` keys exist for the RFC's test vector; production passes none, so every message has a
 * fresh server key and salt. Throws `RangeError` on an oversized payload or malformed keys; the transport maps that to
 * a `refused` outcome.
 */
export function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Buffer,
  authSecret: Buffer,
  injected: { asPrivate?: Buffer; salt?: Buffer } = {},
): Buffer {
  if (plaintext.length > RS - 16 - 1 - HEADER) throw new RangeError("payload_too_large");
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16)
    throw new RangeError("bad_keys");
  const as = createECDH("prime256v1");
  if (injected.asPrivate) as.setPrivateKey(injected.asPrivate);
  else as.generateKeys();
  const asPublic = as.getPublicKey(); // 65 bytes uncompressed
  let shared: Buffer;
  try {
    shared = as.computeSecret(uaPublic); // OpenSSL refuses a point that is not on P-256
  } catch {
    throw new RangeError("bad_keys");
  }
  const salt = injected.salt ?? randomBytes(16);
  const prkKey = hkdf(
    shared,
    authSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const cek = hkdf(prkKey, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(prkKey, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // the 0x02 delimiter marks the last (here the only) record, RFC 8188 section 2
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RS, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}
