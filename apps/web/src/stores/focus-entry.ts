import { create } from "zustand";

interface FocusTarget {
  readonly sessionId: string;
  readonly entryId: string;
}

interface FocusEntryState {
  readonly target: FocusTarget | null;
  ask(target: FocusTarget): void;
  /** The entry asked for this session, once: the transcript that takes it acts on it (M4R108). */
  take(sessionId: string): string | null;
}

/** A search hit's entry the next transcript of that session should scroll to. */
export const useFocusEntry = create<FocusEntryState>()((set, get) => ({
  target: null,
  ask: (target) => set({ target }),
  take(sessionId) {
    const { target } = get();
    if (target?.sessionId !== sessionId) return null;
    set({ target: null });
    return target.entryId;
  },
}));
