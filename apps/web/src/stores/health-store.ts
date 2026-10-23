import { type HealthEvent } from "@pap/contracts";
import { create } from "zustand";
import { appendHealthPage, EMPTY_HEALTH, reduceHealth, type HealthView } from "./health-reducer.ts";

interface HealthStoreState {
  readonly view: HealthView;
  apply(event: unknown): void;
  /** "Load more": a page of `ops.events.list`, older than what is loaded. */
  append(page: { readonly events: readonly HealthEvent[]; readonly hasMore: boolean }): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The daemon's failure console (the `ops` stream). The Health section opens the subscription, not the page load. */
export const useHealthStore = create<HealthStoreState>()((set) => ({
  view: EMPTY_HEALTH,
  apply: (event) => set((state) => ({ view: reduceHealth(state.view, event) })),
  append: (page) => set((state) => ({ view: appendHealthPage(state.view, page) })),
  reset: () => set({ view: EMPTY_HEALTH }),
}));
