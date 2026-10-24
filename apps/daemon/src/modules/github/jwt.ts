import { createSign } from "node:crypto";

const b64 = (value: object | Buffer): string =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString("base64url");

/** The App's JWT (RS256): issued 60 s in the past for clock skew, valid 9 minutes (GitHub allows 10). */
export function signAppJwt(appId: number, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat, exp: iat + 60 + 9 * 60, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(head).sign(privateKeyPem);
  return `${head}.${b64(signature)}`;
}
