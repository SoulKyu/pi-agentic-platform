import { closeSync, openSync, readSync, statSync } from "node:fs";
import { MAX_ID_CHARS } from "../../kernel/text.ts";
import { type EntryLike, type IndexedEntries, indexEntries } from "./branch.ts";

/** A file over this is read from its last `MAX_PARSE_BYTES` only: the oldest history of a huge session is not shown. */
export const MAX_PARSE_BYTES = 32 * 1024 * 1024;
/** Source bytes kept parsed across every file (M2-RT-15); the least recently read file goes first. */
export const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const HEADER_CHUNK = 64 * 1024;
/** How much of the header line and of the bytes before the append point are compared on every read. */
const GUARD_BYTES = 4096;

export type EntriesIssue = "tail_only" | "read_failed" | "long_id" | "bad_lines";
export interface EntriesSdk {
  readonly CURRENT_SESSION_VERSION: number;
  migrateSessionEntries(entries: never[]): void;
}
export interface EntriesCache {
  read(path: string, upToBytes?: number): IndexedEntries;
}

interface Parsed {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /** The offset where the parsed bytes start: 0, or the first whole line of a large file's tail. */
  readonly base: number;
  /** The offset just past the last complete line read: an append is parsed from here. */
  readonly parsedUpTo: number;
  /**
   * The first bytes of the header line (its newline included when it fits): a file rewritten in place (same inode,
   * `openSync(file, "w")`) changes them. `null` when the file has no header line.
   */
  readonly header: Buffer | null;
  /** The offset of the header line's newline. */
  readonly headerEnd: number;
  /** The last bytes read before `parsedUpTo`: a rewrite in place with the same size and mtime changes them. */
  readonly tail: Buffer;
  /** Whether the header's format is current: only then is an appended line parsed without its header. */
  readonly current: boolean;
  readonly entries: readonly EntryLike[];
  /** The offset just past each entry's line, in the same order. */
  readonly ends: readonly number[];
  index: IndexedEntries | null;
  /** The index of the last bounded read: one slot, since a run reads the same bound for its whole length (M4R12). */
  bounded: { readonly upTo: number; readonly index: IndexedEntries } | null;
}

const EMPTY = indexEntries([]);

function readRange(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(fd, buffer, filled, length - filled, start + filled);
      if (read === 0) break;
      filled += read;
    }
    return buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** Complete lines only: the bytes after the last newline are a line Pi is still writing (R38). */
function parseLines(buffer: Buffer, base: number) {
  const records: Array<Record<string, unknown>> = [];
  const ends: number[] = [];
  let bad = 0;
  let start = 0;
  for (let at = buffer.indexOf(0x0a); at !== -1; at = buffer.indexOf(0x0a, start)) {
    const line = buffer.toString("utf8", start, at).trim();
    start = at + 1;
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { type?: unknown }).type === "string"
      ) {
        records.push(value as Record<string, unknown>);
        ends.push(base + start);
      } else bad++;
    } catch {
      // Skipped as Pi's own reader does; counted and reported once per parse by the caller.
      bad++;
    }
  }
  return { records, ends, consumed: base + start, bad };
}

export function createEntriesCache(
  sdk: EntriesSdk,
  options: {
    maxBytes?: number;
    maxCacheBytes?: number;
    onIssue?(issue: EntriesIssue, size: number): void;
  } = {},
): EntriesCache {
  const maxBytes = options.maxBytes ?? MAX_PARSE_BYTES;
  const maxCacheBytes = options.maxCacheBytes ?? MAX_CACHE_BYTES;
  const files = new Map<string, Parsed>();
  const say = (issue: EntriesIssue, size: number) => options.onIssue?.(issue, size);

  const keep = (records: ReadonlyArray<Record<string, unknown>>, ends: readonly number[], size: number) => {
    const entries: EntryLike[] = [];
    const entryEnds: number[] = [];
    let longIds = 0;
    records.forEach((record, index) => {
      if (record.type === "session" || typeof record.id !== "string") return;
      const parent = record.parentId;
      if (record.id.length > MAX_ID_CHARS || (typeof parent === "string" && parent.length > MAX_ID_CHARS)) {
        longIds++;
        return;
      }
      entries.push(record as unknown as EntryLike);
      entryEnds.push(ends[index] ?? 0);
    });
    if (longIds > 0) say("long_id", size);
    return { entries, ends: entryEnds };
  };

  /** The header line, wherever it ends (read in chunks, never beyond `maxBytes`); `null` without a newline. */
  const headerOf = (
    path: string,
    size: number,
  ): { line: string; end: number; record: Record<string, unknown> | null } | null => {
    const limit = Math.min(size, maxBytes);
    const chunks: Buffer[] = [];
    let end = -1;
    for (let at = 0; at < limit && end === -1; at += HEADER_CHUNK) {
      const chunk = readRange(path, at, Math.min(HEADER_CHUNK, limit - at));
      if (chunk.length === 0) break;
      chunks.push(chunk);
      const found = chunk.indexOf(0x0a);
      if (found !== -1) end = at + found;
    }
    if (end === -1) return null;
    const line = Buffer.concat(chunks).toString("utf8", 0, end);
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      return { line, end, record: record?.type === "session" ? record : null };
    } catch {
      return { line, end, record: null };
    }
  };

  const lastBytes = (buffer: Buffer): Buffer => Buffer.from(buffer.subarray(-GUARD_BYTES));

  const full = (path: string, stat: { ino: number; size: number; mtimeMs: number }): Parsed => {
    const header = headerOf(path, stat.size);
    let base = 0;
    let buffer: Buffer;
    if (stat.size > maxBytes) {
      const tail = readRange(path, stat.size - maxBytes, maxBytes);
      const first = tail.indexOf(0x0a);
      base = stat.size - maxBytes + first + 1;
      buffer = tail.subarray(first + 1);
      say("tail_only", stat.size);
    } else buffer = readRange(path, 0, stat.size);
    const parsed = parseLines(buffer, base);
    if (parsed.bad > 0) say("bad_lines", stat.size);
    // The format is read before the migration: it rewrites the header record's version in place.
    const version = header?.record?.version;
    // The header goes with a tail so the migration sees the file's format; it is a no-op for a current file.
    const withHeader = base > 0 && header?.record;
    const records = withHeader
      ? [header.record as Record<string, unknown>, ...parsed.records]
      : parsed.records;
    sdk.migrateSessionEntries(records as never[]);
    const kept = keep(records, withHeader ? [0, ...parsed.ends] : parsed.ends, stat.size);
    return {
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      base,
      parsedUpTo: parsed.consumed,
      header: header ? headerKey(path, header.end) : null,
      headerEnd: header?.end ?? 0,
      tail: lastBytes(buffer.subarray(0, parsed.consumed - base)),
      current: typeof version === "number" && version >= sdk.CURRENT_SESSION_VERSION,
      entries: kept.entries,
      ends: kept.ends,
      index: null,
      bounded: null,
    };
  };

  /** The first bytes of the header line, as they are on disk now. */
  const headerKey = (path: string, headerEnd: number): Buffer =>
    readRange(path, 0, Math.min(headerEnd + 1, GUARD_BYTES));

  /** Whether the header and the last bytes read are as they were: the file was not rewritten in place. */
  const unchanged = (path: string, cached: Parsed): boolean => {
    if (cached.header !== null) {
      if (!headerKey(path, cached.headerEnd).equals(cached.header)) return false;
      // A header longer than the bytes compared: its newline must still be where it was.
      if (cached.headerEnd + 1 > GUARD_BYTES && readRange(path, cached.headerEnd, 1)[0] !== 0x0a)
        return false;
    }
    return cached.tail.length === 0
      ? true
      : readRange(path, cached.parsedUpTo - cached.tail.length, cached.tail.length).equals(cached.tail);
  };

  /** The window slides: a file may grow by half a window before its oldest entries are dropped. */
  const slack = Math.floor(maxBytes / 2);

  const appendable = (path: string, cached: Parsed, stat: { ino: number; size: number }): boolean => {
    if (!cached.current || cached.header === null || stat.ino !== cached.ino || stat.size <= cached.size)
      return false;
    // More than a window of new bytes is read like a new file (tail only), not appended.
    if (stat.size - cached.parsedUpTo > maxBytes) return false;
    return unchanged(path, cached);
  };

  const append = (path: string, cached: Parsed, stat: { size: number; mtimeMs: number }): Parsed => {
    const added = readRange(path, cached.parsedUpTo, stat.size - cached.parsedUpTo);
    const fresh = parseLines(added, cached.parsedUpTo);
    if (fresh.bad > 0) say("bad_lines", stat.size);
    // The header is current (checked): appended lines need no migration, and migrating them alone would be wrong.
    const kept = keep(fresh.records, fresh.ends, stat.size);
    let entries = cached.entries.concat(kept.entries);
    let ends = cached.ends.concat(kept.ends);
    let base = cached.base;
    if (fresh.consumed - base > maxBytes + slack) {
      // Drop the oldest entries until a window is left; nothing is parsed again.
      let drop = 0;
      while (drop < ends.length && fresh.consumed - (ends[drop] ?? 0) > maxBytes) drop++;
      if (drop > 0) {
        if (base === 0) say("tail_only", stat.size);
        base = ends[drop - 1] ?? base;
        entries = entries.slice(drop);
        ends = ends.slice(drop);
      }
    }
    return {
      ...cached,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      base,
      parsedUpTo: fresh.consumed,
      tail: lastBytes(Buffer.concat([cached.tail, added.subarray(0, fresh.consumed - cached.parsedUpTo)])),
      entries,
      ends,
      index: null,
      bounded: null,
    };
  };

  const remember = (path: string, parsed: Parsed): void => {
    files.delete(path);
    files.set(path, parsed);
    const weight = (entry: Parsed) => entry.parsedUpTo - entry.base;
    let total = 0;
    for (const entry of files.values()) total += weight(entry);
    for (const [key, entry] of files) {
      if (total <= maxCacheBytes || key === path) break;
      files.delete(key);
      total -= weight(entry);
    }
  };

  const load = (path: string): Parsed | null => {
    let stat: { ino: number; size: number; mtimeMs: number };
    try {
      const found = statSync(path);
      // A pipe or a device would block the loop on read: only regular files are parsed.
      if (!found.isFile()) {
        files.delete(path);
        say("read_failed", 0);
        return null;
      }
      stat = found;
    } catch {
      // A draft has no file yet (S1): nothing to read, nothing to report.
      files.delete(path);
      return null;
    }
    const cached = files.get(path);
    try {
      if (
        cached &&
        cached.ino === stat.ino &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        unchanged(path, cached)
      ) {
        remember(path, cached);
        return cached;
      }
      const parsed = cached && appendable(path, cached, stat) ? append(path, cached, stat) : full(path, stat);
      remember(path, parsed);
      return parsed;
    } catch {
      say("read_failed", stat.size);
      files.delete(path);
      return null;
    }
  };

  return {
    read(path, upToBytes) {
      const parsed = load(path);
      if (!parsed) return EMPTY;
      if (upToBytes === undefined) return (parsed.index ??= indexEntries(parsed.entries));
      if (parsed.bounded?.upTo !== upToBytes) {
        parsed.bounded = {
          upTo: upToBytes,
          index: indexEntries(
            parsed.entries.filter((_entry, index) => (parsed.ends[index] ?? Infinity) <= upToBytes),
          ),
        };
      }
      return parsed.bounded.index;
    },
  };
}
