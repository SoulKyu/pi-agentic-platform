import { create } from "zustand";

interface PickState {
  /** The winner picked per fan-out, kept while the tab is away: picking opens the winner's lane tab. */
  readonly winners: Readonly<Record<string, string>>;
  pick(fanoutId: string, laneId: string): void;
  clear(fanoutId: string): void;
}

export const useComparePick = create<PickState>()((set) => ({
  winners: {},
  pick: (fanoutId, laneId) => set((state) => ({ winners: { ...state.winners, [fanoutId]: laneId } })),
  clear: (fanoutId) =>
    set((state) => ({
      winners: Object.fromEntries(Object.entries(state.winners).filter(([id]) => id !== fanoutId)),
    })),
}));
