/** M8R106 (RT-08): at most `limit` requests of one owner in flight on one route; the next is refused, never queued. */
export function createInflight(limit: number): { enter(ownerId: string): (() => void) | null } {
  const counts = new Map<string, number>();
  return {
    enter(ownerId) {
      const count = counts.get(ownerId) ?? 0;
      if (count >= limit) return null;
      counts.set(ownerId, count + 1);
      let left = false;
      return () => {
        if (left) return;
        left = true;
        const now = (counts.get(ownerId) ?? 1) - 1;
        if (now === 0) counts.delete(ownerId);
        else counts.set(ownerId, now);
      };
    },
  };
}
