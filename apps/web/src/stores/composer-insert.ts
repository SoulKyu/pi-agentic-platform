import { create } from "zustand";

interface Insert {
  /** Rises with each push, so a subscriber sees a second one for the same session. */
  readonly n: number;
  readonly text: string;
}

interface ComposerInsertState {
  readonly items: Readonly<Record<string, Insert>>;
  push(sessionId: string, text: string): void;
  /** The waiting text, once: null when there is none. */
  take(sessionId: string): string | null;
  reset(): void;
}

/** Text the reply tools (QUOTE, TO KNOWLEDGE) want in a session's composer. Nothing here is ever sent. */
export const useComposerInsert = create<ComposerInsertState>()((set, get) => ({
  items: {},
  push: (sessionId, text) =>
    set((state) => {
      const waiting = state.items[sessionId];
      return {
        items: {
          ...state.items,
          [sessionId]: {
            n: (waiting?.n ?? 0) + 1,
            text: waiting ? `${waiting.text.trimEnd()}\n\n${text}` : text,
          },
        },
      };
    }),
  take(sessionId) {
    const waiting = get().items[sessionId];
    if (!waiting) return null;
    set((state) => ({
      items: Object.fromEntries(Object.entries(state.items).filter(([id]) => id !== sessionId)),
    }));
    return waiting.text;
  },
  reset: () => set({ items: {} }),
}));
