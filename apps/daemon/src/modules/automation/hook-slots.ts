/**
 * Bodies being read at once (RT-01). An `hmac` trigger reads before it can authenticate: those reads share a pool of 8,
 * at most 2 per trigger, so a sender who knows one public hook URL holds 2 reads, never all of them. A `secret`
 * trigger's read starts only after its header secret passed: it takes a slot of its own pool of 4 (2 per trigger), which
 * unauthenticated readers cannot reach. Past a cap: refused (503 `capacity`), never queued.
 */
export const HOOK_SLOTS = {
  unauthenticated: { total: 8, perTrigger: 2 },
  authenticated: { total: 4, perTrigger: 2 },
} as const;

export interface HookSlots {
  /** A release function, or null when the pool or the trigger's share is full. Release is idempotent. */
  take(pool: keyof typeof HOOK_SLOTS, triggerId: string): (() => void) | null;
  inUse(pool: keyof typeof HOOK_SLOTS): number;
}

export function createHookSlots(): HookSlots {
  const pools = {
    unauthenticated: { used: 0, byTrigger: new Map<string, number>() },
    authenticated: { used: 0, byTrigger: new Map<string, number>() },
  };
  return {
    take(name, triggerId) {
      const pool = pools[name];
      const limits = HOOK_SLOTS[name];
      const mine = pool.byTrigger.get(triggerId) ?? 0;
      if (pool.used >= limits.total || mine >= limits.perTrigger) return null;
      pool.used++;
      pool.byTrigger.set(triggerId, mine + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pool.used--;
        const left = (pool.byTrigger.get(triggerId) ?? 1) - 1;
        if (left === 0) pool.byTrigger.delete(triggerId);
        else pool.byTrigger.set(triggerId, left);
      };
    },
    inUse: (name) => pools[name].used,
  };
}
