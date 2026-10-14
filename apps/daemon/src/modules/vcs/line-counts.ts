import { type FileHandle, lstat } from "node:fs/promises";
import { join } from "node:path";
import { VCS_LIMITS } from "@pap/contracts";
import { judgePath, type Scope } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import { BoundaryError, openRegularFile } from "../../kernel/fs/safe-open.ts";
import type { Logger } from "../../kernel/logger.ts";

export interface LineCount {
  /** Lines of a text file; null for a binary file, a file too large to count, or one that may not be read. */
  readonly additions: number | null;
  readonly binary: boolean;
}

export interface LineCounter {
  /** A run of the status begins: the per-run budget of reads starts over. */
  beginRun(): void;
  count(path: string): Promise<LineCount>;
}

export interface LineCounterDeps {
  readonly root: string;
  /** Who may read: the poller passes the strictest scope (a token's over this one root), as the cache is shared. */
  readonly scope: Scope;
  readonly deny: DenySet;
  readonly logger: Logger;
  /** Replaced in tests to count reads. */
  readonly read?: (handle: FileHandle, max: number) => Promise<Buffer>;
  readonly cacheMax?: number;
  readonly readsMax?: number;
}

/** Cached lines per root (M8R45) and the fresh reads one run may make. */
export const LINE_CACHE_MAX = 2000;
export const LINE_READS_PER_RUN = 200;
/** A NUL in this many first bytes makes a file binary (M8R26). */
const BINARY_PROBE_BYTES = 8 * 1024;

const NOT_COUNTED: LineCount = { additions: null, binary: false };
const BINARY: LineCount = { additions: null, binary: true };

/** Errors that only say "not there or not yours": the file stays uncounted. */
const NOT_THERE: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENXIO",
]);

async function readUpTo(handle: FileHandle, max: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(max);
  let filled = 0;
  while (filled < max) {
    const { bytesRead } = await handle.read(buffer, filled, max - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

function linesOf(body: Buffer): number {
  let lines = 0;
  for (let at = body.indexOf(10); at !== -1; at = body.indexOf(10, at + 1)) lines += 1;
  return body.length > 0 && body[body.length - 1] !== 10 ? lines + 1 : lines;
}

/**
 * Line counts of untracked files, which `git diff` does not know (M8R46). Files are opened through the boundary; a count is
 * cached by `(path, size, mtimeMs)` of the open descriptor, so an unchanged file is not read again.
 */
export function createLineCounter(deps: LineCounterDeps): LineCounter {
  const read = deps.read ?? readUpTo;
  const cacheMax = deps.cacheMax ?? LINE_CACHE_MAX;
  const readsMax = deps.readsMax ?? LINE_READS_PER_RUN;
  const cache = new Map<string, { size: number; mtimeMs: number; count: LineCount }>();
  let reads = 0;

  const remember = (path: string, size: number, mtimeMs: number, count: LineCount): void => {
    cache.delete(path);
    if (cache.size >= cacheMax) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(path, { size, mtimeMs, count });
  };

  async function countOpen(path: string, handle: FileHandle): Promise<LineCount> {
    const { size, mtimeMs } = await handle.stat();
    const cached = cache.get(path);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.count;
    if (size > VCS_LIMITS.diffSideBytes || reads >= readsMax) return NOT_COUNTED;
    reads += 1;
    const body = await read(handle, VCS_LIMITS.diffSideBytes + 1);
    // The file grew since the stat: it is too large to count, whatever it said.
    if (body.length > VCS_LIMITS.diffSideBytes) return NOT_COUNTED;
    const count: LineCount = body.subarray(0, BINARY_PROBE_BYTES).includes(0)
      ? BINARY
      : { additions: linesOf(body), binary: false };
    remember(path, size, mtimeMs, count);
    return count;
  }

  return {
    beginRun: () => {
      reads = 0;
    },
    async count(path) {
      // A link is never followed (MC25): its target may be a file the viewer's own boundary hides, and the count would tell.
      const own = await lstat(join(deps.root, path)).catch(() => null);
      if (own === null || own.isSymbolicLink()) return NOT_COUNTED;
      const judgement = await judgePath(join(deps.root, path), deps.scope, "read");
      if (!judgement.ok) return NOT_COUNTED;
      let handle: FileHandle | undefined;
      try {
        handle = await openRegularFile(judgement.real, {
          ...deps.scope,
          root: judgement.root,
          deny: deps.deny,
        });
        return await countOpen(path, handle);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (!(error instanceof BoundaryError) && !(typeof code === "string" && NOT_THERE.has(code)))
          deps.logger.warn("vcs_count_failed", { code: typeof code === "string" ? code : "unknown" });
        return NOT_COUNTED;
      } finally {
        await handle?.close().catch((error: unknown) => {
          deps.logger.debug("vcs_count_close_failed", { code: (error as { code?: unknown }).code });
        });
      }
    },
  };
}
