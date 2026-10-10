import { timingSafeEqual } from "node:crypto";
import { randomToken, sha256Hex } from "../../kernel/ids.ts";

export interface SetupToken {
  /** The raw token, only to build the one URL that is printed; null once consumed or when no setup is needed. */
  current(): string | null;
  verify(candidate: string): boolean;
  consume(): void;
}

// Lives in memory only (a restart issues a new one). Verification never touches the raw token: it compares
// the SHA-256 of the candidate with the stored SHA-256, in constant time over equal-length digests.
export function createSetupToken(active: boolean): SetupToken {
  let token = active ? randomToken(32) : null;
  let digest = token === null ? null : Buffer.from(sha256Hex(token), "hex");
  return {
    current: () => token,
    verify(candidate) {
      if (digest === null || candidate.length > 256) return false;
      return timingSafeEqual(Buffer.from(sha256Hex(candidate), "hex"), digest);
    },
    consume() {
      token = null;
      digest = null;
    },
  };
}
