export interface PendingBudget {
  /** Before the body is read (M8R37, RT-08): the declared length counts at once; null when a cap would pass. */
  reserve(ownerId: string, bytes: number): { keep(): void; cancel(): void } | null;
  /** A kept upload left `pending/`: released after its prompt, or expired. */
  release(ownerId: string, bytes: number): void;
}

/** What one owner holds in `pending/`, uploads still arriving included; full is refused, never evicted. */
export function createPendingBudget(limits: {
  readonly count: number;
  readonly bytes: number;
}): PendingBudget {
  const usage = new Map<string, { readonly count: number; readonly bytes: number }>();
  const change = (ownerId: string, count: number, bytes: number): void => {
    const now = usage.get(ownerId) ?? { count: 0, bytes: 0 };
    const next = { count: now.count + count, bytes: now.bytes + bytes };
    if (next.count <= 0) usage.delete(ownerId);
    else usage.set(ownerId, next);
  };
  return {
    reserve(ownerId, bytes) {
      const now = usage.get(ownerId) ?? { count: 0, bytes: 0 };
      if (now.count + 1 > limits.count || now.bytes + bytes > limits.bytes) return null;
      change(ownerId, 1, bytes);
      let settled = false;
      return {
        keep() {
          settled = true;
        },
        cancel() {
          if (settled) return;
          settled = true;
          change(ownerId, -1, -bytes);
        },
      };
    },
    release(ownerId, bytes) {
      change(ownerId, -1, -bytes);
    },
  };
}
