import { create } from "zustand";
import { useLaneShipStore } from "./lane-ship-store.ts";
import { EMPTY_LANES, failLanes, reduceLanes, type LaneState } from "./lane-reducer.ts";

interface LaneStoreState {
  readonly view: LaneState;
  apply(event: unknown): void;
  fail(code: string): void;
  /** Sign-out: the next account starts from nothing (MC34, agreement 21). */
  reset(): void;
}

/** The owner's lanes (the `lane` stream): the one eager source for tabs, the tree and the palette. */
export const useLaneStore = create<LaneStoreState>()((set) => ({
  view: EMPTY_LANES,
  apply: (event) => set((state) => ({ view: reduceLanes(state.view, event) })),
  fail: (code) => set((state) => ({ view: failLanes(state.view, code) })),
  reset: () => {
    set({ view: EMPTY_LANES });
    useLaneShipStore.getState().reset();
  },
}));
