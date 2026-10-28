import { create } from "zustand";

export interface FilesTarget {
  readonly path: string;
  readonly line: number | null;
  readonly n: number;
}

/** Only the owner's clicks fill it: past this the oldest root's target is dropped. */
const MAX_ROOTS = 32;

interface FilesTargetState {
  readonly targets: Readonly<Record<string, FilesTarget>>;
  /** A path (and line) waits for the Files pane of `root`; a newer push for the root replaces it. */
  push(root: string, path: string, line: number | null): void;
  /** The waiting target, once: the pane that takes it acts on it. */
  take(root: string): FilesTarget | null;
  reset(): void;
}

let counter = 0;

export const useFilesTarget = create<FilesTargetState>()((set, get) => ({
  targets: {},
  push(root, path, line) {
    const others = Object.entries(get().targets).filter(([key]) => key !== root);
    const kept = others.slice(Math.max(0, others.length - (MAX_ROOTS - 1)));
    set({ targets: Object.fromEntries([...kept, [root, { path, line, n: ++counter }]]) });
  },
  take(root) {
    const target = get().targets[root];
    if (!target) return null;
    set({ targets: Object.fromEntries(Object.entries(get().targets).filter(([key]) => key !== root)) });
    return target;
  },
  reset: () => set({ targets: {} }),
}));
