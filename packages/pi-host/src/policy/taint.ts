import { MAX_TAINT_CAUSES, type TaintCause, type TaintCauses, type TaintState } from "@pap/contracts";

export type TaintCauseFacts = Omit<TaintCause, "at" | "count">;

export interface Taint {
  current(): boolean;
  /** Returns true when the flag changed; `report` is called then. A cause is recorded each time (decision 117, A3). */
  raise(cause?: TaintCauseFacts): boolean;
  /** A daemon update (M5R6): a newer epoch replaces the state, the same epoch can only raise, an older one is ignored. Never reports. */
  apply(update: TaintState): void;
  state(): TaintState;
  /**
   * What tainted the session since the last clear (decision 117, A3, APR-8): one entry per (tool, source) with the newest
   * time and a count, newest last, at most 8, and how many older entries were dropped. Once anything not markable was
   * seen in the epoch, or any entry was dropped, every entry says `markable: false`: the card never offers to lift a taint
   * it did not fully name. Empty when the session was already tainted before this worker saw it (init, a daemon update).
   */
  causes(): TaintCauses;
}

export function createTaint(initial: TaintState, report: () => void, now: () => number = Date.now): Taint {
  let state: TaintState = { tainted: initial.tainted, epoch: initial.epoch };
  let list: TaintCause[] = [];
  let older = 0;
  // Sticky for the epoch: a cause that is not markable, an unnamed raise, or a dropped entry.
  let unmarkable = false;
  // Only a taint this worker saw rise from clean has a complete list of causes.
  let known = !initial.tainted;
  const forget = () => {
    list = [];
    older = 0;
    unmarkable = false;
  };
  const record = (cause: TaintCauseFacts | undefined) => {
    if (cause === undefined || !cause.markable) unmarkable = true;
    if (cause === undefined) return;
    const at = Math.max(0, Math.trunc(now()));
    const index = list.findIndex((entry) => entry.tool === cause.tool && entry.source === cause.source);
    const count = (list[index]?.count ?? 0) + 1;
    if (index !== -1) list.splice(index, 1);
    list.push({ ...cause, at, count });
    if (list.length > MAX_TAINT_CAUSES) {
      list.shift();
      older += 1;
      unmarkable = true;
    }
  };
  return {
    current: () => state.tainted,
    raise(cause) {
      record(cause);
      if (state.tainted) return false;
      state = { ...state, tainted: true };
      report();
      return true;
    },
    apply(update) {
      if (update.epoch > state.epoch) {
        state = { tainted: update.tainted, epoch: update.epoch };
        forget();
        known = !update.tainted;
      } else if (update.epoch === state.epoch && update.tainted && !state.tainted) {
        state = { ...state, tainted: true };
        known = false;
        forget();
      }
    },
    state: () => ({ ...state }),
    causes: () =>
      known
        ? { list: list.map((entry) => (unmarkable ? { ...entry, markable: false } : { ...entry })), older }
        : { list: [], older: 0 },
  };
}

const MAX_ROOTS = 1000;

/** The calls whose result is external because a nested call under them was (M5R39). Bounded; the oldest is dropped. */
export interface ExternalRoots {
  /** `source` names the fence of the result when it is not the tool's own name (an agent's runs folder: `agent-run`, M11R181; another agent's home: `agent-home`, W5-R45). */
  add(root: string, source?: string): void;
  /** The source a root was added with, without taking the root. */
  source?(root: string): string | undefined;
  /** Removes the root and says whether it was there. */
  take(root: string): boolean;
  clear(): void;
}

export function createExternalRoots(): ExternalRoots {
  const roots = new Map<string, string | undefined>();
  return {
    add(root, source) {
      if (roots.has(root)) {
        if (source !== undefined) roots.set(root, source);
        return;
      }
      if (roots.size >= MAX_ROOTS) {
        const oldest = roots.keys().next();
        if (!oldest.done) roots.delete(oldest.value);
      }
      roots.set(root, source);
    },
    source: (root) => roots.get(root),
    take: (root) => roots.delete(root),
    clear: () => roots.clear(),
  };
}
