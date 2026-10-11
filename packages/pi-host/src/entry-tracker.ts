import { slimEntry } from "./wire-events.ts";
import type { Outbound } from "./ipc.ts";

/** The most entries one flush sends; a longer burst goes out in batches, one per macrotask. */
export const MAX_FLUSH_ENTRIES = 128;
/** The most entries one walk from the leaf looks at. A burst beyond it (or a long jump) is one `leaf` resync record. */
export const MAX_WALK_ENTRIES = 4096;
/** The entries Pi announced itself that are remembered, so none is sent twice. Larger than a walk, so a remembered id never falls off a path being walked. */
export const MAX_KNOWN_ENTRIES = 8192;

/** The events after which Pi may have appended an entry (`message_end` appends right after its listeners ran). */
const MAY_APPEND = new Set([
  "message_end",
  "compaction_end",
  "turn_end",
  "agent_end",
  "agent_settled",
  "entry_appended",
]);

export interface EntryManager {
  getLeafId(): string | null;
  getEntry(id: string): ({ id: string; parentId: string | null } & object) | undefined;
}

export interface EntryTrackerDeps {
  readonly manager: EntryManager;
  send(record: Outbound): unknown;
  /** Runs the task on the next macrotask; `setImmediate` in the worker. */
  defer(task: () => void): void;
  onError(error: unknown): void;
}

export interface EntryTracker {
  /** Every Pi event, as Pi emitted it: the ones that may have appended an entry schedule a check of the leaf. */
  observe(event: { readonly type: string; readonly entry?: unknown }): void;
  /** A command that moves the leaf has answered (`navigate_tree`). */
  leafMayHaveMoved(): void;
}

/**
 * Pi 1.1.0 announces no `entry_appended` for messages or manual compactions, so the daemon would never learn their ids.
 * This looks at `SessionManager.getLeafId()` one macrotask after an event that may have appended (never at the file:
 * Pi writes it after its listeners ran, R38) and, when the leaf moved, sends the entries from the new leaf back to
 * the leaf it last reported as `entry_appended` records of the same slim shape Pi's own take. A leaf that moved without
 * a chain back to the old one (navigation, or a walk beyond `MAX_WALK_ENTRIES`) is sent as a `leaf` record instead. A burst is sent in batches of `MAX_FLUSH_ENTRIES`, one per macrotask.
 */
export function createEntryTracker(deps: EntryTrackerDeps): EntryTracker {
  const { manager } = deps;
  let reported = manager.getLeafId();
  let scheduled = false;
  const announced = new Set<string>();

  // Entries found by a walk and not yet sent, oldest first, and the leaf that walk started from.
  let pending: Array<{ id: string; parentId: string | null }> = [];
  let pendingLeaf: string | null = null;
  let lastSent: string | null = null;

  // Looks at the leaf; when it moved along a chain from the reported one, queues the entries not announced yet.
  function walk(): void {
    const leaf = manager.getLeafId();
    if (leaf === reported) return;
    const fresh: Array<{ id: string; parentId: string | null }> = [];
    let reachedReported = false;
    let overflow = false;
    for (let id = leaf; ;) {
      if (id === reported) {
        reachedReported = true;
        break;
      }
      if (id === null) break;
      if (fresh.length >= MAX_WALK_ENTRIES) {
        overflow = true;
        break;
      }
      const entry = manager.getEntry(id);
      if (!entry) break;
      fresh.push(entry);
      id = entry.parentId;
    }
    reported = leaf;
    if (!reachedReported) {
      deps.send({ type: "leaf", leafId: leaf, resync: overflow });
      return;
    }
    pending = fresh.toReversed().filter((entry) => !announced.has(entry.id));
    pendingLeaf = leaf;
    lastSent = null;
    if (pending.length === 0) deps.send({ type: "leaf", leafId: leaf, resync: false });
  }

  function flush(): void {
    scheduled = false;
    try {
      if (pending.length === 0) walk();
      if (pending.length === 0) return;
      for (const entry of pending.splice(0, MAX_FLUSH_ENTRIES)) {
        deps.send({ type: "entry_appended", entry: slimEntry(entry as unknown as Record<string, unknown>) });
        lastSent = entry.id;
      }
      if (pending.length > 0) schedule();
      else if (lastSent !== pendingLeaf) deps.send({ type: "leaf", leafId: pendingLeaf, resync: false });
    } catch (error) {
      pending = [];
      deps.onError(error);
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    deps.defer(flush);
  }

  return {
    observe(event) {
      if (typeof event !== "object" || event === null || typeof event.type !== "string") return;
      if (!MAY_APPEND.has(event.type)) return;
      if (event.type === "entry_appended") {
        const id = (event.entry as { id?: unknown } | null | undefined)?.id;
        if (typeof id === "string") {
          announced.add(id);
          if (announced.size > MAX_KNOWN_ENTRIES) announced.delete(announced.values().next().value as string);
        }
      }
      schedule();
    },
    leafMayHaveMoved: schedule,
  };
}
