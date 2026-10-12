import { lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { isIndexDamaged } from "./index-db.ts";
import { type FileContext, type FileOutcome, processFile } from "./scanner-file.ts";
import type { WatchFactory } from "./watch.ts";

export const DEBOUNCE_MS = 250;
/** A file written more often than every 250 ms is still read this soon after its first event (M4R71). */
export const DEBOUNCE_MAX_MS = 1_000;
export const MAX_WATCHED_DIRS = 512;
export const MAX_QUEUE = 20_000;

export interface ScanEngine {
  /** Watches `<root>`, or its parent until `<root>` exists. */
  watchRoot(): void;
  watchFolder(dir: string): void;
  /** A file changed: read it once its writes pause, and at most a second after the first change (M4R71). */
  debounce(path: string): void;
  enqueue(path: string): void;
  /** Resolves when no step runs. */
  idle(): Promise<void>;
  /** Closes every watcher, clears every debounce and the queue, and waits for the running step. */
  close(): Promise<void>;
}

/** A stable, short code for an error: never its message, which may hold a path or file text. */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "error";
};

/**
 * Every path the engine watches or hands to `processFile` is `resolve`d: absolute, normalised, symlinks untouched.
 * That is the spelling of the `pi_path` the sessions module stores for a session pap launched (Pi joins the agent
 * folder it was given), so the file is claimed by that session instead of being adopted twice (`duplicate_id`).
 */
export function createScanEngine(deps: {
  readonly root: string;
  readonly ctx: FileContext;
  readonly watch: WatchFactory;
  readonly clock: Clock;
  readonly logger: Logger;
  /** One rate-limited warning per event name. */
  say(event: string, fields?: Record<string, unknown>): void;
  /** What events cannot tell (a full queue, a nameless event, a new folder): list again soon. */
  requestReconcile(): void;
  /** SQLite called the index damaged while a file was processed (M4R127). */
  onDamaged(): void;
  readonly process?: (path: string, ctx: FileContext) => FileOutcome;
  readonly yieldNow?: () => Promise<void>;
  readonly maxQueue?: number;
}): ScanEngine {
  const process = deps.process ?? processFile;
  const yieldNow = deps.yieldNow ?? (() => new Promise<void>((resolveYield) => setImmediate(resolveYield)));
  const maxQueue = deps.maxQueue ?? MAX_QUEUE;
  const root = resolve(deps.root);
  const watchers = new Map<string, () => void>();
  const debounces = new Map<string, { readonly timer: TimerHandle; readonly first: number }>();
  const queue = new Set<string>();
  const waiters: Array<() => void> = [];
  let pumping: Promise<void> | null = null;
  let closed = false;

  // `say` and the callbacks run inside catch blocks and watch callbacks: nothing they do may escape (M4R136).
  const tell = (event: string, fields?: Record<string, unknown>): void => {
    try {
      deps.say(event, fields);
    } catch {
      // The sink is broken; there is nowhere left to say it.
    }
  };
  const attempt = (call: () => void): void => {
    try {
      call();
    } catch (error) {
      tell("session_watch_callback_failed", { code: codeOf(error) });
    }
  };
  const reconcile = (): void => attempt(deps.requestReconcile);

  const isFolder = (path: string): boolean => {
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink();
    } catch (error) {
      tell("session_folder_unreadable", { code: codeOf(error) });
      return false;
    }
  };

  const watchDir = (dir: string, onEvent: (name: string | null) => void): void => {
    if (closed || watchers.has(dir)) return;
    if (watchers.size >= MAX_WATCHED_DIRS) {
      tell("session_watch_limit", { max: MAX_WATCHED_DIRS });
      return;
    }
    const close = deps.watch(
      dir,
      (name) => attempt(() => onEvent(name)),
      (code) => {
        watchers.delete(dir);
        tell("session_watch_failed", { code });
      },
    );
    if (close) watchers.set(dir, close);
  };

  function watchFolder(folder: string): void {
    const dir = resolve(folder);
    watchDir(dir, (name) => {
      if (name === null) reconcile();
      else if (name.endsWith(".jsonl")) debounce(join(dir, name));
    });
  }

  function watchRoot(): void {
    if (closed) return;
    const parent = dirname(root);
    if (!isFolder(root)) {
      watchDir(parent, (name) => {
        if (name !== null && name !== basename(root)) return;
        watchRoot();
        reconcile();
      });
      return;
    }
    watchDir(root, (name) => {
      if (name === null) return reconcile();
      const folder = join(root, name);
      if (!isFolder(folder)) return;
      watchFolder(folder);
      reconcile();
    });
    const parentWatcher = watchers.get(parent);
    if (parentWatcher) {
      watchers.delete(parent);
      attempt(parentWatcher);
    }
  }

  function debounce(path: string): void {
    if (closed) return;
    const now = deps.clock.now();
    const current = debounces.get(path);
    if (!current && debounces.size >= maxQueue) return reconcile();
    if (current) deps.clock.clearTimeout(current.timer);
    const first = current?.first ?? now;
    // Trailing 250 ms, but never later than a second after the burst's first event (M4R71).
    const wait = Math.min(DEBOUNCE_MS, Math.max(0, first + DEBOUNCE_MAX_MS - now));
    const timer = deps.clock.setTimeout(() => {
      debounces.delete(path);
      enqueue(path);
    }, wait);
    debounces.set(path, { timer, first });
  }

  function enqueue(path: string): void {
    if (closed) return;
    if (!queue.has(path) && queue.size >= maxQueue) {
      tell("session_queue_full", { max: maxQueue });
      reconcile();
      return;
    }
    queue.delete(path);
    queue.add(path);
    pump();
  }

  function pump(): void {
    if (pumping || closed) return;
    pumping = (async () => {
      while (!closed && queue.size > 0) {
        const path = queue.values().next().value as string;
        queue.delete(path);
        let outcome: FileOutcome | null = null;
        try {
          outcome = process(path, deps.ctx);
        } catch (error) {
          tell("session_scan_failed", { code: codeOf(error) });
          if (isIndexDamaged(error)) attempt(deps.onDamaged);
        }
        if (outcome?.kind === "indexed" && outcome.more && !closed) queue.add(path);
        await yieldNow();
      }
    })()
      .catch((error: unknown) => deps.logger.error("session_scan_pump_failed", { err: error }))
      .finally(() => {
        pumping = null;
        for (const release of waiters.splice(0)) release();
      });
  }

  return {
    watchRoot,
    watchFolder,
    debounce,
    enqueue,
    idle: () => (pumping ? new Promise<void>((release) => waiters.push(release)) : Promise.resolve()),
    async close() {
      closed = true;
      for (const { timer } of debounces.values()) deps.clock.clearTimeout(timer);
      debounces.clear();
      for (const close of watchers.values()) attempt(close);
      watchers.clear();
      queue.clear();
      await pumping;
    },
  };
}
