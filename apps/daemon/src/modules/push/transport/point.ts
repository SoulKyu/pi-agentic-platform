import { createPublicKey } from "node:crypto";

/** A browser P-256 key: 65 bytes, 0x04 prefix, (x, y) on the curve. */
export function validPublicPoint(p256dh: string): boolean {
  if (!/^[A-Za-z0-9_-]{87}$/.test(p256dh)) return false;
  const point = Buffer.from(p256dh, "base64url");
  if (point.length !== 65 || point[0] !== 4) return false;
  try {
    // OpenSSL checks that (x, y) is on P-256 when the JWK is imported. Do not drop this check to "fix" a test: an off-curve point must be refused here.
    createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    return true;
  } catch {
    return false;
  }
}

/** The 16-byte auth secret: 22 base64url characters exactly (Buffer would otherwise skip `=`, `+` and spaces). */
export const authSecretOf = (auth: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(auth)) return null;
  const b = Buffer.from(auth, "base64url");
  return b.length === 16 ? b : null;
};
