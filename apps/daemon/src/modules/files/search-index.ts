import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { FILE_LIMITS, INVISIBLE } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import { judgeName, type Scope } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import { openFolder } from "../../kernel/fs/safe-open.ts";
import { GitError, type GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import { EXCLUDED_NAMES } from "./visibility.ts";

/** M8R27: what one index and the cache of them may hold. */
export const INDEX_LIMITS = {
  roots: 16,
  ttlMs: 30_000,
  paths: 100_000,
  gitBytes: 8 * 1024 * 1024,
  walkDepth: 16,
  walkFiles: 20_000,
  /** Folders opened by one walk, and entries read from one folder, at most. */
  walkFolders: 5000,
  walkEntries: 10_000,
  /** A walk answers what it has after this long (a hung mount cannot stall `@`). */
  walkDeadlineMs: 5000,
} as const;

type IndexLimits = { readonly [K in keyof typeof INDEX_LIMITS]: number };

export interface PathIndex {
  /** Paths relative to the root, with no line break, bidi control or other invisible character. */
  readonly paths: readonly string[];
  /** The index was cut at one of its limits. */
  readonly truncated: boolean;
}

export interface SearchIndexDeps {
  readonly git: GitRunner;
  readonly deny: DenySet;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface SearchIndex {
  /** The index of `root` for this owner, built at most every 30 s. A failure is not cached. */
  paths(ownerId: string, scope: Scope, root: string): Promise<PathIndex>;
  clear(): void;
}

/**
 * A mention carries the path into a prompt: a name that can hide text (`a\nIgnore previous…`, a bidi override) never enters
 * the index. A folder entry from git (`dir/`, a nested repository) is not a file.
 */
function indexable(path: string): boolean {
  return (
    path !== "" &&
    !path.endsWith("/") &&
    path.length <= FILE_LIMITS.pathBytes &&
    !INVISIBLE.test(path) &&
    !/\p{Surrogate}/u.test(path)
  );
}

/** Whether a caller may be offered this path: the boundary's name judgement, which a token meets in full (M8R102). */
export function readableBy(scope: Scope, root: string): (path: string) => boolean {
  return (path) => judgeName(join(root, path), scope) === null;
}

async function fromGit(git: GitRunner, root: string, limits: IndexLimits): Promise<PathIndex> {
  const listed = await git.run(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    maxBytes: limits.gitBytes,
  });
  const paths: string[] = [];
  let truncated = false;
  for (const path of listed.stdout.toString("utf8").split("\0")) {
    if (!indexable(path)) continue;
    if (paths.length === limits.paths) {
      truncated = true;
      break;
    }
    paths.push(path);
  }
  return { paths, truncated };
}

/** What a walk has found so far; the deadline answers with it while the walk may still be blocked in a system call. */
interface WalkState {
  readonly paths: string[];
  truncated: boolean;
  /** Set by the deadline: the walk stops at its next step. */
  stopped: boolean;
}

async function walkInto(
  state: WalkState,
  deps: SearchIndexDeps,
  scope: Scope,
  root: string,
  limits: IndexLimits,
): Promise<void> {
  // What is offered must not depend on who asked first: the walk judges as a session, answers filter per caller.
  const walker: Scope = { ...scope, caller: "session" };
  const pending: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  let folders = 0;
  while (pending.length > 0 && !state.truncated && !state.stopped) {
    if (folders === limits.walkFolders) {
      state.truncated = true;
      break;
    }
    folders += 1;
    const { rel, depth } = pending.pop() ?? { rel: "", depth: 0 };
    const real = rel === "" ? root : join(root, rel);
    try {
      const folder = await openFolder(real, { ...walker, root, deny: deps.deny });
      try {
        if (state.stopped) break;
        const dir = await opendir(folder.path);
        let read = 0;
        try {
          for await (const entry of dir) {
            if (state.stopped) break;
            if (++read > limits.walkEntries) {
              state.truncated = true;
              break;
            }
            const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
            if (entry.name === ".git" || judgeName(join(root, path), walker) !== null) continue;
            if (entry.isDirectory() && !EXCLUDED_NAMES.has(entry.name)) {
              if (depth < limits.walkDepth) pending.push({ rel: path, depth: depth + 1 });
              else state.truncated = true;
            } else if (entry.isFile() && indexable(path)) {
              if (state.paths.length === limits.walkFiles) {
                state.truncated = true;
                break;
              }
              state.paths.push(path);
            }
          }
        } finally {
          await dir.close().catch((error: unknown) => {
            deps.logger.debug("search_walk_close_failed", { code: (error as { code?: unknown }).code });
          });
        }
      } finally {
        await folder.close();
      }
    } catch (error) {
      // A folder that cannot be opened or read is left out of the index; the walk goes on.
      deps.logger.debug("search_walk_skipped", { code: (error as { code?: unknown }).code ?? "boundary" });
    }
  }
}

interface Build {
  /** The index, or what the walk had when its deadline came. */
  readonly index: Promise<PathIndex>;
  /** The work behind it has ended (a walk blocked on a mount can outlive `index`). */
  readonly ended: Promise<void>;
}

/** Outside git: folders read through a held descriptor, depth 16, 20 000 files, 5 000 folders, a deadline on the clock. */
function walkFiles(deps: SearchIndexDeps, scope: Scope, root: string, limits: IndexLimits): Build {
  const state: WalkState = { paths: [], truncated: false, stopped: false };
  const walk = walkInto(state, deps, scope, root, limits).catch((error: unknown) => {
    deps.logger.warn("search_walk_failed", { err: error });
  });
  let timer: TimerHandle | null = null;
  const late = new Promise<"late">((resolve) => {
    timer = deps.clock.setTimeout(() => resolve("late"), limits.walkDeadlineMs);
  });
  const index = Promise.race([walk.then(() => "done" as const), late]).then((outcome) => {
    if (timer) deps.clock.clearTimeout(timer);
    if (outcome === "late") {
      state.stopped = true;
      state.truncated = true;
      deps.logger.warn("search_walk_late", { files: state.paths.length });
    }
    return { paths: [...state.paths], truncated: state.truncated };
  });
  return { index, ended: walk };
}

function build(deps: SearchIndexDeps, scope: Scope, root: string, limits: IndexLimits): Build {
  const fromGitOrWalk = fromGit(deps.git, root, limits).then(
    (index): Build => ({ index: Promise.resolve(index), ended: Promise.resolve() }),
    (error: unknown): Build => {
      // Only git's own failures fall back to the walk; a busy runner (`capacity`) is the caller's to hear about.
      if (!(error instanceof GitError)) throw error;
      return walkFiles(deps, scope, root, limits);
    },
  );
  return {
    index: fromGitOrWalk.then((b) => b.index),
    ended: fromGitOrWalk.then(
      (b) => b.ended,
      () => undefined,
    ),
  };
}

export function createSearchIndex(deps: SearchIndexDeps, limits: IndexLimits = INDEX_LIMITS): SearchIndex {
  // Map order is use order: the first key is the least recently used. `endedAt` is null while the work behind the index
  // runs: such an entry is joined whatever its age, and the TTL counts from the end (a stalled walk is never doubled).
  const cache = new Map<string, { endedAt: number | null; readonly index: Promise<PathIndex> }>();
  return {
    paths(ownerId, scope, root) {
      const key = `${ownerId}\0${root}`;
      const now = deps.clock.now();
      const hit = cache.get(key);
      cache.delete(key);
      if (hit && (hit.endedAt === null || now - hit.endedAt < limits.ttlMs)) {
        cache.set(key, hit);
        return hit.index;
      }
      const started = build(deps, scope, root, limits);
      const entry: { endedAt: number | null; readonly index: Promise<PathIndex> } = {
        endedAt: null,
        index: started.index,
      };
      void started.ended.then(() => {
        entry.endedAt = deps.clock.now();
      });
      cache.set(key, entry);
      for (const oldest of cache.keys()) {
        if (cache.size <= limits.roots) break;
        cache.delete(oldest);
      }
      entry.index.catch(() => {
        if (cache.get(key) === entry) cache.delete(key);
      });
      return entry.index;
    },
    clear: () => cache.clear(),
  };
}
