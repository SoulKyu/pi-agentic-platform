import { create } from "zustand";

/** The next palette opening is transcript search only, narrowed to a project when one is named (§3.2, PH8). */
export interface PaletteSearch {
  readonly projectId: string | null;
}

interface PaletteRequestState {
  readonly search: PaletteSearch | null;
  askSearch(projectId: string | null): void;
  /** Reads the request and clears it: a later plain opening never sees a stale one. */
  take(): PaletteSearch | null;
}

/** The home cannot reach the palette's host (features never import routes): it asks here, then runs `palette.toggle`. */
export const usePaletteRequest = create<PaletteRequestState>()((set, get) => ({
  search: null,
  askSearch: (projectId) => set({ search: { projectId } }),
  take: () => {
    const { search } = get();
    set({ search: null });
    return search;
  },
}));
