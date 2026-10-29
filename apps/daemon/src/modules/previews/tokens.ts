import { createHash, randomBytes } from "node:crypto";
import { type BoxRef, boxKey, PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

/** Spec §4 and decision 6. Every cap refuses when full (`limit_reached`); none evicts a live token. */
export const PREVIEW_TOKEN_LIMITS = Object.freeze({
  /** A service token lives this long after its last renewal (the pane renews every `renewMs`). */
  leaseMs: 5 * 60_000,
  renewMs: 60_000,
  /** An artifact token dies this long after it was minted; it is never renewed. */
  artifactMs: 60 * 60_000,
  /** A fence asked again gets its live token back while at least this much of its hour is left (red team I9). */
  artifactReuseMs: 5 * 60_000,
  servicePerOwner: 32,
  serviceTotal: 256,
  artifactPerOwner: 32,
  artifactTotal: 128,
  /** The HTML of one artifact, held in memory with its token. */
  artifactBytes: 256 * 1024,
});

export interface ServiceGrant {
  readonly kind: "service";
  readonly ownerId: string;
  readonly box: BoxRef;
  readonly serviceId: string;
  readonly port: number;
  /** Decision 139: the CSP host sources of the session's egress list at mint (`hostSources`); empty without network. */
  readonly sources: readonly string[];
}
export interface ArtifactGrant {
  readonly kind: "artifact";
  readonly ownerId: string;
  readonly sessionId: string;
  readonly entryId: string;
  readonly fenceIndex: number;
  readonly html: string;
}
export type PreviewGrant = ServiceGrant | ArtifactGrant;

export interface PreviewTokens {
  mintService(grant: Omit<ServiceGrant, "kind">): { token: string; lease: string; until: number };
  /** The pane's renewal: the owner's own live lease only. Its new end, or null (unknown, expired, another owner's). */
  renew(ownerId: string, lease: string): number | null;
  /** The pane closed (`previews.close`): the owner's own lease and its token die now. False when there was none. */
  close(ownerId: string, lease: string): boolean;
  /**
   * The artifact of one fence: the live token of the same owner, session, entry and fence when it has `artifactReuseMs` left,
   * else a new one (the old one keeps its place until its hour ends, so one fence holds at most two).
   */
  mintArtifact(grant: Omit<ArtifactGrant, "kind">): { token: string; until: number };
  /** The grant of a live token of that kind, or null (unknown, expired, revoked, the other kind). */
  resolve(kind: PreviewGrant["kind"], token: string): PreviewGrant | null;
  /** The service stopped, exited or restarted: its tokens die (spec §4). */
  revokeService(serviceId: string): number;
  /** The box stopped: every service token of it dies. */
  revokeBox(box: BoxRef): number;
  /** A disabled or deleted user: every token they minted dies. */
  revokeOwner(ownerId: string): number;
  /** Drops expired entries (the composition calls it every `renewMs` on the kernel clock). */
  sweep(): void;
}

interface Entry {
  readonly grant: PreviewGrant;
  until: number;
  readonly lease: string | null;
  /** An artifact's token, kept so the same fence gets it back (I9); null for a service, which is never handed out twice. */
  readonly token: string | null;
}

/** The map key: a token's SHA-256. A service token is held nowhere but in the caller's answer. */
const keyOf = (token: string): string => createHash("sha256").update(token).digest("hex");
const newToken = (): string => randomBytes(32).toString("base64url");
const fenceOf = (grant: Omit<ArtifactGrant, "kind">): string =>
  JSON.stringify([grant.ownerId, grant.sessionId, grant.entryId, grant.fenceIndex]);

/** In memory only (spec §4): a daemon restart revokes every preview link. */
export function createPreviewTokens(clock: Clock): PreviewTokens {
  const entries = new Map<string, Entry>();
  const leases = new Map<string, string>();
  /** The newest token key of each fence; bounded by the artifact entries, dropped with them. */
  const fences = new Map<string, string>();

  const drop = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    if (entry.lease !== null) leases.delete(entry.lease);
    if (entry.grant.kind === "artifact") {
      const fence = fenceOf(entry.grant);
      if (fences.get(fence) === key) fences.delete(fence);
    }
  };
  const live = (key: string): Entry | null => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (clock.now() < entry.until) return entry;
    drop(key);
    return null;
  };
  const sweep = (): void => {
    for (const key of [...entries.keys()]) live(key);
  };
  const count = (kind: PreviewGrant["kind"], ownerId?: string): number => {
    let n = 0;
    for (const { grant } of entries.values())
      if (grant.kind === kind && (ownerId === undefined || grant.ownerId === ownerId)) n++;
    return n;
  };
  const roomFor = (kind: PreviewGrant["kind"], ownerId: string, perOwner: number, total: number): void => {
    sweep();
    if (count(kind, ownerId) >= perOwner || count(kind) >= total) throw new PapError("limit_reached");
  };
  const revokeWhere = (match: (grant: PreviewGrant) => boolean): number => {
    let n = 0;
    for (const [key, entry] of [...entries])
      if (match(entry.grant)) {
        drop(key);
        n++;
      }
    return n;
  };
  const ownLease = (ownerId: string, lease: string): { key: string; entry: Entry } | null => {
    const key = leases.get(lease);
    const entry = key === undefined ? null : live(key);
    return key === undefined || entry === null || entry.grant.ownerId !== ownerId ? null : { key, entry };
  };

  return {
    mintService(grant) {
      const { servicePerOwner, serviceTotal, leaseMs } = PREVIEW_TOKEN_LIMITS;
      roomFor("service", grant.ownerId, servicePerOwner, serviceTotal);
      const token = newToken();
      const lease = randomBytes(16).toString("hex");
      const until = clock.now() + leaseMs;
      const key = keyOf(token);
      entries.set(key, {
        grant: { kind: "service", ...grant, sources: [...grant.sources] },
        until,
        lease,
        token: null,
      });
      leases.set(lease, key);
      return { token, lease, until };
    },
    renew(ownerId, lease) {
      const found = ownLease(ownerId, lease);
      if (found === null) return null;
      found.entry.until = clock.now() + PREVIEW_TOKEN_LIMITS.leaseMs;
      return found.entry.until;
    },
    close(ownerId, lease) {
      const found = ownLease(ownerId, lease);
      if (found === null) return false;
      drop(found.key);
      return true;
    },
    mintArtifact(grant) {
      const { artifactPerOwner, artifactTotal, artifactMs, artifactBytes, artifactReuseMs } =
        PREVIEW_TOKEN_LIMITS;
      if (Buffer.byteLength(grant.html, "utf8") > artifactBytes) throw new PapError("payload_too_large");
      const fence = fenceOf(grant);
      const known = fences.get(fence);
      const reused = known === undefined ? null : live(known);
      if (reused?.token != null && reused.until - clock.now() >= artifactReuseMs)
        return { token: reused.token, until: reused.until };
      roomFor("artifact", grant.ownerId, artifactPerOwner, artifactTotal);
      const token = newToken();
      const until = clock.now() + artifactMs;
      const key = keyOf(token);
      entries.set(key, { grant: { kind: "artifact", ...grant }, until, lease: null, token });
      fences.set(fence, key);
      return { token, until };
    },
    resolve(kind, token) {
      const entry = live(keyOf(token));
      return entry !== null && entry.grant.kind === kind ? entry.grant : null;
    },
    revokeService: (serviceId) =>
      revokeWhere((grant) => grant.kind === "service" && grant.serviceId === serviceId),
    revokeBox: (box) => revokeWhere((grant) => grant.kind === "service" && boxKey(grant.box) === boxKey(box)),
    revokeOwner: (ownerId) => revokeWhere((grant) => grant.ownerId === ownerId),
    sweep,
  };
}
