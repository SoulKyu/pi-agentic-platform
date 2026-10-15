/** What takes the lane lock: archive, commit, restore and the checkpoint captures. Push does not (M9R69). */
export type LockKind = "archive" | "commit" | "restore" | "checkpoint";

export interface LaneLock {
  /** Runs `fn` after every run queued before it on this lane has ended; the result or the error is the caller's. */
  run<T>(kind: LockKind, fn: () => Promise<T>): Promise<T>;
}

export interface LaneLocks {
  laneLock(laneId: string): LaneLock;
  /** While a restore holds the lock: the promise of its end, which never rejects; else null (M9R114). */
  holdsFiles(cwd: string): Promise<void> | null;
}

/** One promise chain per lane (M9R120). Tasks 14, 15 and 18b use this; nobody builds a second one. */
export function createLaneLocks(laneIdAt: (cwd: string) => string | null): LaneLocks {
  const tails = new Map<string, Promise<void>>();
  const restoring = new Map<string, Promise<void>>();
  return {
    laneLock: (laneId) => ({
      run(kind, fn) {
        const turn = (tails.get(laneId) ?? Promise.resolve()).then(() => {
          if (kind !== "restore") return fn();
          // The wait of a prompt starts when the restore starts holding the files, not when it queued.
          const running = fn();
          const ended = running.then(
            () => undefined,
            () => undefined,
          );
          restoring.set(laneId, ended);
          void ended.then(() => {
            if (restoring.get(laneId) === ended) restoring.delete(laneId);
          });
          return running;
        });
        const tail = turn.then(
          () => undefined,
          () => undefined,
        );
        tails.set(laneId, tail);
        void tail.then(() => {
          if (tails.get(laneId) === tail) tails.delete(laneId);
        });
        return turn;
      },
    }),
    holdsFiles(cwd) {
      const laneId = laneIdAt(cwd);
      return laneId === null ? null : (restoring.get(laneId) ?? null);
    },
  };
}
