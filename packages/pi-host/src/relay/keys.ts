import { createHash, timingSafeEqual } from "node:crypto";
import type { BoxRef } from "@pap/contracts/pi-host";

/** What the daemon hands the relay at a VM's start (RT-03): the launch's relay key, its box and the VM's bridge address. */
export interface RelayGrant {
  readonly launchId: string;
  readonly box: BoxRef;
  /** 32 random bytes; the worker presents them as 64 hex characters in the provider's own credential header. */
  readonly key: Buffer;
  readonly address: string;
}
const KEY = /^[0-9a-f]{64}$/;
const digest = (hex: string): string => createHash("sha256").update(hex, "utf8").digest("hex");

/**
 * The credential a request presents, from whichever header its SDK uses: `x-api-key` (Anthropic), `x-goog-api-key` (Google),
 * `authorization: Bearer` (OpenAI, the bridge's `claude`). Two that differ, or one that is not a relay key: none.
 */
export function presentedKey(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | null {
  const found = new Set<string>();
  for (const name of ["x-api-key", "x-goog-api-key"]) {
    const value = headers[name];
    if (Array.isArray(value)) return null;
    if (value !== undefined) found.add(value);
  }
  const auth = headers.authorization;
  if (Array.isArray(auth)) return null;
  if (auth !== undefined) {
    const bearer = /^Bearer ([^\s]+)$/.exec(auth);
    if (bearer === null) return null;
    found.add(bearer[1] as string);
  }
  if (found.size !== 1) return null;
  const [key] = found;
  return key !== undefined && KEY.test(key) ? key : null;
}

export type RelayKeys = ReturnType<typeof createRelayKeys>;

/** The live relay keys (RT-03, owner Q4): looked up by digest, compared in constant time, bound to the VM's address. */
export function createRelayKeys() {
  const byDigest = new Map<string, RelayGrant>();
  const digestOf = new Map<string, string>();
  const revoked = new Set<(launchId: string) => void>();
  const forget = (launchId: string): void => {
    const found = digestOf.get(launchId);
    if (found !== undefined) byDigest.delete(found);
    digestOf.delete(launchId);
  };
  /** A revoke: the key goes, then whoever holds a request open for it is told (a stream outlives a lookup). */
  const remove = (launchId: string): void => {
    forget(launchId);
    for (const listener of revoked) listener(launchId);
  };
  return {
    /** Called after a key was revoked (`remove`), never after a re-grant or a replacement. */
    onRemove(listener: (launchId: string) => void): void {
      revoked.add(listener);
    },
    add(grant: RelayGrant): void {
      if (grant.key.length !== 32) throw new RangeError("relay key");
      // A launch has one key: a second grant for it replaces the first instead of leaving both valid.
      forget(grant.launchId);
      const hex = grant.key.toString("hex");
      byDigest.set(digest(hex), grant);
      digestOf.set(grant.launchId, digest(hex));
    },
    remove,
    /** The launch and box a request speaks for, or null: unknown or revoked key, or a key presented from another address. */
    grantOf(
      key: string | null,
      address: string | undefined,
    ): { readonly launchId: string; readonly box: BoxRef } | null {
      if (key === null || address === undefined || !KEY.test(key)) return null;
      const grant = byDigest.get(digest(key));
      if (grant === undefined) return null;
      const same = timingSafeEqual(Buffer.from(key, "hex"), grant.key);
      return same && grant.address === address ? { launchId: grant.launchId, box: grant.box } : null;
    },
    boxOf(key: string | null, address: string | undefined): BoxRef | null {
      return this.grantOf(key, address)?.box ?? null;
    },
  };
}
