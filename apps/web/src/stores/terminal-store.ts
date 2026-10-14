import type { TerminalView } from "@pap/contracts";
import { create } from "zustand";
import { EMPTY_TERMINALS, reduceTerminals, type TerminalsView } from "./terminal-reducer.ts";

interface TerminalStoreState {
  readonly view: TerminalsView;
  apply(event: unknown): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The owner's terminals (the `terminal` stream). */
export const useTerminalStore = create<TerminalStoreState>()((set) => ({
  view: EMPTY_TERMINALS,
  apply: (event) => set((state) => ({ view: reduceTerminals(state.view, event) })),
  reset: () => set({ view: EMPTY_TERMINALS }),
}));

export function useTerminals(): readonly TerminalView[] {
  return useTerminalStore((state) => state.view.list);
}
