import { createDecipheriv, hkdfSync, type ECDH } from "node:crypto";

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, len));

/**
 * Test-side inverse of `encryptPayload` (RFC 8291 / RFC 8188, one record). Used by the fake push service and the int
 * tests to read what the transport sent. Throws on a bad tag, a bad header or a record that is not the last one.
 */
export function decryptPayload(body: Buffer, uaPrivateEcdh: ECDH, authSecret: Buffer): Buffer {
  if (body.length < 21 + 65 + 17) throw new RangeError("short_body");
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyIdLength = body[20] ?? 0;
  if (keyIdLength !== 65 || recordSize < 18 || body.length > 21 + keyIdLength + recordSize)
    throw new RangeError("bad_header");
  const asPublic = body.subarray(21, 21 + keyIdLength);
  const record = body.subarray(21 + keyIdLength);
  const uaPublic = uaPrivateEcdh.getPublicKey();
  const shared = uaPrivateEcdh.computeSecret(asPublic);
  const prkKey = hkdf(
    shared,
    authSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const cek = hkdf(prkKey, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(prkKey, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  if (end === 0 || padded[end - 1] !== 2) throw new RangeError("bad_delimiter");
  return padded.subarray(0, end - 1);
}
