/** Entries one user may hold at once; the oldest of their own goes first, so a member never evicts the owner's pending sign-in. */
export const PER_USER = 8;

/**
 * Makes room for one more entry of `userId` in an insertion-ordered map: that user's oldest entries go past `PER_USER`, then,
 * past the global `ceiling`, the oldest entry of whoever holds the most (a flood from one user costs that user first).
 */
export function makeRoom<T>(
  entries: Map<string, T>,
  userOf: (entry: T) => string,
  userId: string,
  ceiling: number,
): void {
  const own: string[] = [];
  for (const [key, entry] of entries) if (userOf(entry) === userId) own.push(key);
  for (const key of own.slice(0, Math.max(0, own.length - PER_USER + 1))) entries.delete(key);
  while (entries.size >= ceiling) {
    const counts = new Map<string, number>();
    for (const entry of entries.values()) counts.set(userOf(entry), (counts.get(userOf(entry)) ?? 0) + 1);
    const heaviest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const oldest = [...entries].find(([, entry]) => userOf(entry) === heaviest)?.[0];
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}
