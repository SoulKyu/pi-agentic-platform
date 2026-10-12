import { lstatSync, type Stats } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileCursor, SearchIndexStore } from "./index-store.ts";
import type { ScanEngine } from "./scanner-engine.ts";

export const LIST_YIELD_EVERY = 500;
/** `lstat` calls per pass; the next pass goes on where this one stopped (M4R72). */
export const RECONCILE_STATS = 20_000;

/** A stable, short code for an error: never its message, which may hold a path or file text. */
export const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "unknown";
};

/** A file's `lstat`: undefined when it is gone, null when it could not be read (said). */
function statOf(
  path: string,
  say: (event: string, fields?: Record<string, unknown>) => void,
): Stats | undefined | null {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    say("session_list_failed", { code: codeOf(error) });
    return null;
  }
}

/** What a pass keeps for the next one. */
export interface ReconcileState {
  /** Where the stat round robin goes on from. */
  at: number;
  /** The folders the last complete listing held: one that is gone from the next gets its watcher closed. */
  folders: Set<string>;
}

/** One reconcile pass (M4R72): lists everything, queues what changed, compares a bounded number of files. */
export async function reconcilePass(deps: {
  readonly root: string;
  readonly store: SearchIndexStore;
  readonly engine: Pick<ScanEngine, "watchRoot" | "watchFolder" | "unwatch" | "enqueue">;
  yieldNow(): Promise<void>;
  stopped(): boolean;
  say(event: string, fields?: Record<string, unknown>): void;
  readonly state: ReconcileState;
  readonly maxStats?: number;
}): Promise<void> {
  let folders: string[];
  try {
    folders = (await readdir(deps.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(deps.root, entry.name));
  } catch (error) {
    if (codeOf(error) !== "ENOENT") deps.say("session_list_failed", { code: codeOf(error) });
    if (deps.stopped()) return;
    for (const gone of deps.state.folders) deps.engine.unwatch(gone);
    deps.state.folders.clear();
    deps.engine.watchRoot();
    return;
  }
  if (deps.stopped()) return;
  deps.engine.watchRoot();
  const listed = new Set<string>();
  const compare: FileCursor[] = [];
  const present = new Set<string>();
  let seen = 0;
  for (const folder of folders) {
    const files = await readdir(folder, { withFileTypes: true }).catch((error: unknown) => {
      // A folder that vanished since the root was listed is not an error: the next listing drops it.
      if (codeOf(error) !== "ENOENT") deps.say("session_list_failed", { code: codeOf(error) });
      return null;
    });
    if (deps.stopped()) return;
    if (files === null) continue;
    present.add(folder);
    deps.engine.watchFolder(folder);
    const cursors = deps.store.cursorsIn(folder);
    for (const file of files) {
      if (++seen % LIST_YIELD_EVERY === 0) {
        await deps.yieldNow();
        if (deps.stopped()) return;
      }
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const path = join(folder, file.name);
      listed.add(path);
      const cursor = cursors.get(path);
      if (!cursor || cursor.state === "waiting") deps.engine.enqueue(path);
      else if (cursor.state !== "excluded") compare.push(cursor);
    }
  }
  for (const gone of deps.state.folders) if (!present.has(gone)) deps.engine.unwatch(gone);
  deps.state.folders = present;
  // At most `maxStats` comparisons, round robin across passes (RT-26).
  const max = Math.min(compare.length, deps.maxStats ?? RECONCILE_STATS);
  const start = compare.length === 0 ? 0 : deps.state.at % compare.length;
  for (let i = 0; i < max; i++) {
    const cursor = compare[(start + i) % compare.length] as FileCursor;
    if (i > 0 && i % LIST_YIELD_EVERY === 0) {
      await deps.yieldNow();
      if (deps.stopped()) return;
    }
    const stat = statOf(cursor.path, deps.say);
    if (stat === null) continue;
    if (!stat || stat.ino !== cursor.ino || stat.size !== cursor.size || stat.mtimeMs !== cursor.mtimeMs)
      deps.engine.enqueue(cursor.path);
  }
  deps.state.at = start + max;
  if (deps.stopped()) return;
  for (const path of deps.store.paths()) if (!listed.has(path)) deps.engine.enqueue(path);
}
