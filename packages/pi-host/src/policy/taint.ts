import type { TaintState } from "@pap/contracts";

export interface Taint {
  current(): boolean;
  /** Returns true when the flag changed; `report` is called then. */
  raise(): boolean;
  /** A daemon update (M5R6): a newer epoch replaces the state, the same epoch can only raise, an older one is ignored. Never reports. */
  apply(update: TaintState): void;
  state(): TaintState;
}

export function createTaint(initial: TaintState, report: () => void): Taint {
  let state: TaintState = { tainted: initial.tainted, epoch: initial.epoch };
  return {
    current: () => state.tainted,
    raise() {
      if (state.tainted) return false;
      state = { ...state, tainted: true };
      report();
      return true;
    },
    apply(update) {
      if (update.epoch > state.epoch) state = { tainted: update.tainted, epoch: update.epoch };
      else if (update.epoch === state.epoch && update.tainted && !state.tainted)
        state = { ...state, tainted: true };
    },
    state: () => ({ ...state }),
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
