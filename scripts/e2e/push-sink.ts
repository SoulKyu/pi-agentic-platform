// A push service for J13: an `http` server on 127.0.0.1 that keeps every POST it receives, and the user-agent side of
// RFC 8291 (aes128gcm) for a P-256 key pair of its own, so a journey reads what the daemon sent. The daemon accepts the
// endpoint only with PAP_TEST_PUSH_LOOPBACK=1 (tests only). No `@pap/*` import: the daemon's push module is off limits to
// scripts (boundaries) and Playwright's loader has no `development` condition.
import { createDecipheriv, createECDH, type ECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export interface PushHit {
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface PushSink {
  /** `http://127.0.0.1:<port>`; a subscription's endpoint is `<url>/push/<anything>`. */
  url: string;
  received(): PushHit[];
  keys: { p256dh: string; auth: string; decrypt(hit: PushHit): string };
  close(): Promise<void>;
}

const hkdf = (ikm: Buffer, salt: Buffer, info: string | Buffer, length: number): Buffer =>
  Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

/**
 * RFC 8291 section 3.4 with RFC 8188 framing, one record: header (salt 16, record size 4, key id length 1, key id = the
 * sender's public key), then the ciphertext and its tag. `ua` holds the user agent's private key, `auth` its secret.
 */
export function decryptAes128gcm(body: Buffer, ua: ECDH, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = hkdf(ua.computeSecret(asPublic), auth, keyInfo, 32);
  const key = hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdf(ikm, salt, "Content-Encoding: nonce\0", 12);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  // plaintext, then 0x02 (last record), then zero padding
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1;
  if (padded[end - 1] !== 2) throw new Error("the record does not end with the last-record delimiter");
  return padded.subarray(0, end - 1).toString("utf8");
}

export async function startPushSink(): Promise<PushSink> {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const hits: PushHit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method !== "POST" || !(req.url ?? "").startsWith("/push/")) {
        res.writeHead(404).end();
        return;
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers))
        headers[name] = [value ?? ""].flat().join(", ");
      hits.push({ path: req.url ?? "", headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the push sink has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    received: () => [...hits],
    keys: {
      p256dh: ua.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
      decrypt: (hit) => decryptAes128gcm(hit.body, ua, auth),
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
