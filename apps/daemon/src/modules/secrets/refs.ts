import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SECRET_REF = /^secret-ref:[0-9a-f]{32}$/;
export const ONCE_LIMITS = { perAgent: 3, ttlMs: 24 * 60 * 60_000 } as const;

/**
 * T3's rule (`SecretRequests.ts`): one ref per request, the HMAC of the request id under a salt only the daemon holds
 * (`$PAP_HOME/secrets/vault/ref-salt`, 32 random bytes, made like the key). Its length never depends on the id, and
 * nobody can make one for a request without the salt.
 */
export const refOf = (salt: Buffer, requestId: string): string =>
  `secret-ref:${createHmac("sha256", salt).update(`pap-secret-ref-v1\u0000${requestId}`).digest("hex").slice(0, 32)}`;

/** What `agent_requests.ref_hash` keeps: never the ref itself. */
export const refHash = (ref: string): string => createHash("sha256").update(ref).digest("hex");

export const sameRef = (a: string, b: string): boolean => {
  const left = Buffer.from(refHash(a), "hex");
  const right = Buffer.from(refHash(b), "hex");
  return timingSafeEqual(left, right);
};

export interface OnceValue {
  /** Random, minted at the answer: the only identity of an entry. Two answers with one value are two entries. */
  readonly id: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * "Use once" answers (owner m6): kept in the daemon's memory only (never on disk: C §3.1, ADR 0049) until the agent's
 * first sandboxed command that names `$NAME` uses it, 24 hours at most. At most 3 waiting per agent: the 4th answer is
 * refused (`limit_reached`), never an eviction (caps refuse, brief). Lost at a restart: the agent asks again.
 */
export function createOnceStore(now: () => number) {
  const waiting = new Map<string, OnceValue>(); // key: ref hash
  const sweep = () => {
    const at = now();
    for (const [key, entry] of waiting) if (entry.expiresAt <= at) waiting.delete(key);
  };
  const held = (agentId: string): number =>
    [...waiting.values()].filter((each) => each.agentId === agentId).length;
  return {
    /** Whether `put` would keep one more for this agent now; asked before anything is audited or kept. */
    roomFor(agentId: string): boolean {
      sweep();
      return held(agentId) < ONCE_LIMITS.perAgent;
    },
    put(ref: string, entry: Omit<OnceValue, "expiresAt">): "ok" | "limit_reached" {
      sweep();
      if (held(entry.agentId) >= ONCE_LIMITS.perAgent) return "limit_reached";
      waiting.set(refHash(ref), { ...entry, expiresAt: now() + ONCE_LIMITS.ttlMs });
      return "ok";
    },
    /** What the session's worker must hold now (its init, or a `vault_update` after a restart). */
    forSession(sessionId: string): { id: string; name: string; value: string; expiresAt: number }[] {
      sweep();
      return [...waiting.values()]
        .filter((each) => each.sessionId === sessionId)
        .map(({ id, name, value, expiresAt }) => ({ id, name, value, expiresAt }));
    },
    /** The worker used it (`secret_used {id}`): exactly that entry of that session goes; a repeat or another id deletes nothing. */
    used(sessionId: string, id: string): boolean {
      for (const [key, entry] of waiting)
        if (entry.sessionId === sessionId && entry.id === id) {
          waiting.delete(key);
          return true;
        }
      return false;
    },
    /** Quarantine, delete, the thread reset. */
    dropAgent(agentId: string): number {
      let dropped = 0;
      for (const [key, entry] of waiting)
        if (entry.agentId === agentId) {
          waiting.delete(key);
          dropped++;
        }
      return dropped;
    },
    size: () => waiting.size,
  };
}
export type OnceStore = ReturnType<typeof createOnceStore>;
