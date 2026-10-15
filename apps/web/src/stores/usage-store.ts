import { create } from "zustand";
import { EMPTY_USAGE, failUsage, reduceUsage, type UsageView } from "./usage-reducer.ts";

interface UsageStoreState {
  readonly view: UsageView;
  apply(event: unknown): void;
  fail(code: string): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The owner's quota limits and today's spend (the `usage` stream, M10R107). */
export const useUsageStore = create<UsageStoreState>()((set) => ({
  view: EMPTY_USAGE,
  apply: (event) => set((state) => ({ view: reduceUsage(state.view, event) })),
  fail: (code) => set((state) => ({ view: failUsage(state.view, code) })),
  reset: () => set({ view: EMPTY_USAGE }),
}));
