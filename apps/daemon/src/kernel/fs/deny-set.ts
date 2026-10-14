import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, TimerHandle } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { cutUnits } from "../text.ts";

/** Entries read per walk, at most; past it the set cannot vouch for a linked file and refuses it (fail closed). */
export const DENY_WALK_MAX = 50_000;

/** Private keys remembered at most; past it the set cannot vouch for a linked file and refuses it (fail closed, never evicts). */
export const DENY_KEYS_MAX = 100_000;
/**
 * A walk that has not finished this long after it started (a hung mount behind a link) leaves the set unable to vouch:
 * every check answers "private" until the walk completes (R2).
 */
export const DENY_WALK_DEADLINE_MS = 15_000;
const LOG_PATH_CHARS = 300;
/** A filesystem stamps a ctime with its own granularity and clock: compare with this much slack. */
const CTIME_SLACK_MS = 2000;

export interface DenySources {
  /** Named single files (M8R103): `<agentDir>/{auth,models,mcp,trust,settings}.json`, `$PAP_HOME/{state.db,state.db-wal,state.db-shm,pap.lock}`. */
  readonly files: readonly string[];
  /** Folders walked whole, links followed once: `<agentDir>/sessions`, the named `$PAP_HOME/{secrets,backups,exports,fork-tmp}` and all of `$PAP_HOME` (search.db and the rest). */
  readonly folders: readonly string[];
  /** Folders and files never walked or listed: what the owner may browse under `$PAP_HOME` (`papHomeOpen`). */
  readonly skip: readonly string[];
}

export interface DenyStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly ctimeMs: bigint;
  readonly birthtimeNs: bigint;
}

export interface DenySet {
  /** M8R103 (RT-01): the file is one of pap's or Pi's private files reached under another name (hard link, swapped folder, case-folded spelling). */
  has(stat: DenyStat): Promise<boolean>;
  /** Starts the first walk now, with its deadline (boot), so the first check does not pay for it. */
  warm(): void;
}

/** The birth time keeps a reused inode number from matching a key of a file that is gone. */
const keyOf = (st: { readonly dev: bigint; readonly ino: bigint; readonly birthtimeNs: bigint }): string =>
  `${st.dev}:${st.ino}:${st.birthtimeNs}`;

export interface DenySetOptions {
  /** Every link the walk follows is logged (N5). */
  readonly logger?: Logger;
  readonly deadlineMs?: number;
}

export function createDenySet(
  sources: DenySources,
  clock: Clock,
  max: number = DENY_WALK_MAX,
  maxKeys: number = DENY_KEYS_MAX,
  options: DenySetOptions = {},
): DenySet {
  const deadlineMs = options.deadlineMs ?? DENY_WALK_DEADLINE_MS;
  // `remembered` lives as long as the daemon: a private file renamed away or unlinked keeps its aliases refused.
  const remembered = new Set<string>();
  let keys = new Set<string>();
  // True when the last walk was cut or could not read something, or the remembered keys are full.
  let capped = false;
  let builtAt: number | null = null;
  // The walk in flight, and the promise that settles `false` when it outruns the deadline.
  let building: { readonly done: Promise<void>; readonly late: Promise<false>; expired: boolean } | null =
    null;

  async function build(): Promise<void> {
    const startedAt = clock.now();
    const next = new Set<string>();
    let unreadable = false;
    const add = async (path: string): Promise<void> => {
      try {
        next.add(keyOf(await stat(path, { bigint: true })));
      } catch (error) {
        // Missing: nothing to deny under that name. Anything else (EACCES...): the walk cannot vouch.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
      }
    };
    const skipped = (path: string): boolean => sources.skip.includes(path);
    for (const file of sources.files) if (!skipped(file)) await add(file);
    let seen = 0;
    const stack = [...sources.folders];
    // Folders already walked (by inode): a link is followed once, and a cycle ends. The skipped folders are in it from
    // the start, so a link to one under another name is not walked either (R4).
    const visited = new Set<string>();
    const skippedKeys = new Set<string>();
    for (const path of sources.skip) {
      try {
        const key = keyOf(await stat(path, { bigint: true }));
        visited.add(key);
        skippedKeys.add(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
      }
    }
    walk: while (stack.length > 0) {
      const folder = stack.pop() as string;
      try {
        const folderKey = keyOf(await stat(folder, { bigint: true }));
        if (visited.has(folderKey)) continue;
        visited.add(folderKey);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
        continue;
      }
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
        continue;
      }
      for (const entry of entries) {
        if (++seen > max) break walk;
        const path = join(folder, entry.name);
        if (skipped(path)) continue;
        if (entry.isDirectory()) stack.push(path);
        else if (entry.isFile()) await add(path);
        else if (entry.isSymbolicLink()) {
          // Followed once, counted in the cap: a private folder or file may be a link (kernel/home.ts tolerates them).
          try {
            const target = await stat(path, { bigint: true });
            options.logger?.debug("deny_walk_link_followed", { path: cutUnits(path, LOG_PATH_CHARS) });
            if (target.isDirectory()) stack.push(path);
            else if (target.isFile() && !skippedKeys.has(keyOf(target))) next.add(keyOf(target));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable = true;
          }
        }
      }
    }
    keys = next;
    for (const key of next) {
      if (remembered.size >= maxKeys) {
        unreadable = true;
        break;
      }
      remembered.add(key);
    }
    capped = seen > max || unreadable || remembered.size >= maxKeys;
    builtAt = startedAt;
  }

  /** Runs or joins a walk. False: it is still running at the deadline, and the set cannot vouch. */
  async function refresh(): Promise<boolean> {
    if (building === null) {
      let timer: TimerHandle | null = null;
      const late = new Promise<false>((resolve) => {
        timer = clock.setTimeout(() => {
          if (started) started.expired = true;
          // Until a walk completes every file is refused: the owner sees not_found everywhere (MC38 m6).
          if (builtAt === null) options.logger?.warn("deny_first_walk_late", { deadlineMs });
          resolve(false);
        }, deadlineMs);
      });
      const started = {
        done: build()
          .catch((error: unknown) => options.logger?.warn("deny_walk_failed", { err: error }))
          .finally(() => {
            if (timer) clock.clearTimeout(timer);
            building = null;
          }),
        late,
        expired: false,
      };
      building = started;
    }
    if (building.expired) return false;
    const current = building;
    return Promise.race([current.done.then(() => true), current.late]);
  }

  const isPrivate = (st: DenyStat): boolean => keys.has(keyOf(st)) || remembered.has(keyOf(st));

  return {
    warm() {
      // refresh() never rejects: a failed walk is logged and leaves the set unable to vouch.
      void refresh();
    },
    async has(st) {
      // Until a walk has completed the set knows no inode: it refuses everything rather than vouch (R2).
      if (builtAt === null && !(await refresh())) return true;
      if (builtAt === null) return true;
      if (isPrivate(st)) return true;
      // A hard link leaves nlink >= 2 on both names; a file with one name is private only as a known inode.
      if (st.nlink < 2n) return false;
      // Linking a file changes its ctime: one linked after a walk started may be a new private file. Two tries,
      // because a walk already running may have started before the link; still not covered: refuse (fail closed).
      const changedSinceWalk = (): boolean => Number(st.ctimeMs) + CTIME_SLACK_MS >= (builtAt ?? 0);
      for (let tries = 0; tries < 2 && changedSinceWalk(); tries++) {
        // A walk that outruns the deadline leaves `builtAt` where it was, so `changedSinceWalk` stays true: refused below.
        await refresh();
        if (isPrivate(st)) return true;
      }
      return capped || changedSinceWalk();
    },
  };
}
