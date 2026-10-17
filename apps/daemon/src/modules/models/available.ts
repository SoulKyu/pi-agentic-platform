import type { AvailableModels } from "@pap/contracts";

export const AVAILABLE_TTL_MS = 10_000;
export const AVAILABLE_CACHE_KEYS = 32;

export interface AvailableCache {
  /** A cached value, or the run in flight for `key`, or a new run of `load`. Concurrent callers share one run. */
  read(key: string, now: number, load: () => Promise<AvailableModels>): Promise<AvailableModels>;
  /** Every write path calls this: drops values and makes runs already in flight unable to store their result. */
  clear(): void;
}

/**
 * MP-RT-06. A read that started before a `clear()` still answers its own caller, but it never stores its result and a
 * later read does not join it, so a write is never hidden by an older read.
 */
export function createAvailableCache(): AvailableCache {
  const values = new Map<string, { readonly value: AvailableModels; readonly at: number }>();
  const flying = new Map<string, Promise<AvailableModels>>();
  let generation = 0;
  return {
    read(key, now, load) {
      const hit = values.get(key);
      if (hit !== undefined && now - hit.at < AVAILABLE_TTL_MS) return Promise.resolve(hit.value);
      const running = flying.get(key);
      if (running !== undefined) return running;
      const started = generation;
      const run = load().then(
        (value) => {
          if (flying.get(key) === run) flying.delete(key);
          for (const [other, held] of values) if (now - held.at >= AVAILABLE_TTL_MS) values.delete(other);
          if (started === generation && (values.has(key) || values.size < AVAILABLE_CACHE_KEYS))
            values.set(key, { value, at: now });
          return value;
        },
        (error: unknown) => {
          if (flying.get(key) === run) flying.delete(key);
          throw error;
        },
      );
      flying.set(key, run);
      return run;
    },
    clear() {
      generation++;
      values.clear();
      flying.clear();
    },
  };
}
