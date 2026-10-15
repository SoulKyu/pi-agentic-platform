import type { ConfigRead } from "./project-config.ts";

export const CONFIG_CACHE_MAX = 64;

/** What identifies a file's content cheaply: a change of any part is a re-read. */
export interface FileKey {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  readonly mtimeMs: number;
}

const same = (a: FileKey, b: FileKey): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * The last read per project root, at most 64 roots, the oldest dropped: a pure cache, an eviction costs one re-parse.
 * A token's `lanes.preview` loop never parses an unchanged file again (M9R22, M9-RT-12).
 */
export function createConfigCache(max: number = CONFIG_CACHE_MAX) {
  const entries = new Map<string, { key: FileKey; read: ConfigRead }>();
  return {
    async get(root: string, key: FileKey, load: () => Promise<ConfigRead>): Promise<ConfigRead> {
      const hit = entries.get(root);
      if (hit && same(hit.key, key)) return hit.read;
      const read = await load();
      // Re-inserted: the map's order is the age of the last read.
      entries.delete(root);
      entries.set(root, { key, read });
      if (entries.size > max) entries.delete(entries.keys().next().value as string);
      return read;
    },
    size: (): number => entries.size,
  };
}
