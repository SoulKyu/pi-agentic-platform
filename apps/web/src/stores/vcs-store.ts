import type { VcsStatus } from "@pap/contracts";
import { create } from "zustand";
import { EMPTY_VCS, reduceVcs, type VcsView } from "./vcs-reducer.ts";

interface VcsStoreState {
  readonly view: VcsView;
  apply(root: string, event: unknown): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The git status of the roots the screens watch (the `vcs` stream, one subscription per root). */
export const useVcsStore = create<VcsStoreState>()((set) => ({
  view: EMPTY_VCS,
  apply: (root, event) => set((state) => ({ view: reduceVcs(state.view, root, event) })),
  reset: () => set({ view: EMPTY_VCS }),
}));

/** The status of one root; null until the first snapshot, and for a folder that is not a repository. */
export function useVcs(root: string): VcsStatus | null {
  return useVcsStore((state) => state.view.statuses.get(root) ?? null);
}
