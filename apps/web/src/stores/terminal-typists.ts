import { create } from "zustand";

export type HandOffOutcome = "typed" | "multiline" | "not_ready";

export interface TerminalTypist {
  handOff(text: string): HandOffOutcome;
}

interface TerminalTypistsState {
  readonly typists: Readonly<Record<string, TerminalTypist>>;
  /** One typist per terminal; the remover removes this typist only, never a newer one of the same terminal. */
  register(terminalId: string, typist: TerminalTypist): () => void;
  reset(): void;
}

/** The mounted terminal panes, by terminal id: what a reply's TO TERMINAL types through. */
export const useTerminalTypists = create<TerminalTypistsState>()((set, get) => ({
  typists: {},
  register(terminalId, typist) {
    set({ typists: { ...get().typists, [terminalId]: typist } });
    return () => {
      if (get().typists[terminalId] !== typist) return;
      set({ typists: Object.fromEntries(Object.entries(get().typists).filter(([id]) => id !== terminalId)) });
    };
  },
  reset: () => set({ typists: {} }),
}));
