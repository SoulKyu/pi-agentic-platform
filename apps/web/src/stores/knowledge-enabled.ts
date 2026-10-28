import { create } from "zustand";

interface KnowledgeEnabledState {
  /** Per session: whether OKF knowledge is on, as the session's chip last learned it. Absent: not known (no chip). */
  readonly enabled: Readonly<Record<string, boolean>>;
  /** `null` forgets the session (the chip unmounted). */
  setEnabled(sessionId: string, value: boolean | null): void;
  reset(): void;
}

/** What the chip knows, for the reply tools to read (TO KNOWLEDGE shows only when it is on). Store layer: no feature import. */
export const useKnowledgeEnabled = create<KnowledgeEnabledState>()((set) => ({
  enabled: {},
  setEnabled: (sessionId, value) =>
    set((state) => {
      const rest = Object.fromEntries(Object.entries(state.enabled).filter(([id]) => id !== sessionId));
      return { enabled: value === null ? rest : { ...rest, [sessionId]: value } };
    }),
  reset: () => set({ enabled: {} }),
}));
