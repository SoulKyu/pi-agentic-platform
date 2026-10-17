import type { SessionLive, SubscriptionsPort, SubscriptionTarget } from "../index.ts";

export interface MemorySubscriptions extends SubscriptionsPort, SessionLive {
  add(ownerId: string, target: SubscriptionTarget): void;
  /** Rows removed through `drop`, in order. */
  readonly dropped: Array<{ id: string; why: "gone" | "dead_session" }>;
  /** Time of the last `markOk`, by row id. */
  readonly okAt: Map<string, number>;
  /** All sessions live (true, the default) or none (false), or a rule per owner and credential. */
  setSessionLive(live: boolean | ((ownerId: string, credentialId: string) => boolean)): void;
}

/** Chain B's subscription store: no cap, no validation (chain A's store owns those). */
export function createMemorySubscriptions(): MemorySubscriptions {
  const rows: Array<{ ownerId: string; target: SubscriptionTarget }> = [];
  const dropped: MemorySubscriptions["dropped"] = [];
  const okAt = new Map<string, number>();
  let live: boolean | ((ownerId: string, credentialId: string) => boolean) = true;
  return {
    dropped,
    okAt,
    add: (ownerId, target) => void rows.push({ ownerId, target }),
    targets: (ownerId, credentialId) =>
      rows
        .filter(
          (row) =>
            row.ownerId === ownerId &&
            (credentialId === undefined || row.target.credentialId === credentialId),
        )
        .map((row) => row.target),
    drop(id, why) {
      const at = rows.findIndex((row) => row.target.id === id);
      if (at >= 0) rows.splice(at, 1);
      dropped.push({ id, why });
    },
    markOk: (id, at) => void okAt.set(id, at),
    setSessionLive: (value) => void (live = value),
    sessionLive: (ownerId, credentialId) => (typeof live === "function" ? live(ownerId, credentialId) : live),
  };
}
