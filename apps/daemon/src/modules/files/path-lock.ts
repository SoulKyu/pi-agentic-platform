/**
 * MC38 m1: one promise chain per real path, so the base check and the atomic replace of two writers to the same file
 * never interleave (`files.write` and `PUT /files/raw` share it). The map holds only paths with work in flight: an entry
 * is deleted when its chain settles, so it never grows with the paths seen.
 */
export interface PathLock {
  run<T>(real: string, work: () => Promise<T>): Promise<T>;
  /** Paths with work queued or running (tests). */
  readonly size: number;
}

export function createPathLock(): PathLock {
  const tails = new Map<string, Promise<void>>();
  return {
    get size() {
      return tails.size;
    },
    run(real, work) {
      const previous = tails.get(real) ?? Promise.resolve();
      const result = previous.then(work);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(real, tail);
      void tail.then(() => {
        if (tails.get(real) === tail) tails.delete(real);
      });
      return result;
    },
  };
}
