import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

const NONCE_BYTES = 16;
const EXPIRY_BYTES = 8;
const MAC_BYTES = 32;
const LABEL = "pap-passkey-login";

export interface LoginChallenges {
  /** nonce (16) ‖ expiry in ms since the epoch (8, big endian) ‖ HMAC-SHA256(key, label ‖ nonce ‖ expiry). */
  issue(): Buffer;
  /** Throws `unauthenticated` for anything not issued by this process, expired, or already taken. */
  take(challenge: string): void;
}

// R82: a sign-in challenge proves itself, so the server keeps nothing per challenge issued. An unauthenticated
// client can ask for any number of them without evicting another's, whatever address it comes from. The key
// lives only in memory: a restart refuses every challenge issued before it. Single use is the one thing that
// needs memory, and only for challenges somebody actually answered: the nonce is kept until the challenge
// would have expired anyway, and each answer that fails counts against the sender's throttle.
export function createLoginChallenges(
  clock: Clock,
  ttlMs: number,
  key: Buffer = randomBytes(32),
): LoginChallenges {
  const taken = new Map<string, number>();
  const mac = (nonce: Buffer, expiry: Buffer) =>
    createHmac("sha256", key).update(LABEL).update(nonce).update(expiry).digest();
  const refuse = () => new PapError("unauthenticated");
  return {
    issue() {
      const nonce = randomBytes(NONCE_BYTES);
      const expiry = Buffer.alloc(EXPIRY_BYTES);
      expiry.writeBigUInt64BE(BigInt(clock.now() + ttlMs));
      return Buffer.concat([nonce, expiry, mac(nonce, expiry)]);
    },
    take(challenge) {
      const bytes = Buffer.from(challenge, "base64url");
      if (
        bytes.length !== NONCE_BYTES + EXPIRY_BYTES + MAC_BYTES ||
        bytes.toString("base64url") !== challenge
      ) {
        throw refuse();
      }
      const nonce = bytes.subarray(0, NONCE_BYTES);
      const expiry = bytes.subarray(NONCE_BYTES, NONCE_BYTES + EXPIRY_BYTES);
      if (!timingSafeEqual(bytes.subarray(NONCE_BYTES + EXPIRY_BYTES), mac(nonce, expiry))) throw refuse();
      const expiresAt = Number(expiry.readBigUInt64BE());
      const now = clock.now();
      if (expiresAt <= now) throw refuse();
      for (const [seen, until] of taken) if (until <= now) taken.delete(seen);
      const id = nonce.toString("base64url");
      if (taken.has(id)) throw refuse();
      taken.set(id, expiresAt);
    },
  };
}
