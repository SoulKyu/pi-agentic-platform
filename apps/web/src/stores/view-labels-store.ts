import { create } from "zustand";

export interface ViewLabel {
  readonly name: string | null;
  readonly cwd: string;
}

interface ViewLabelsState {
  readonly labels: Readonly<Record<string, ViewLabel>>;
  /** A no-op unless the name or folder changed: a streamed token re-renders nobody (M4R86). */
  put(sessionId: string, label: ViewLabel): void;
}

/** What titles a tab of a session the shell store lacks. Eager and tiny: the session reducer stays in its lazy chunk. */
export const useViewLabels = create<ViewLabelsState>()((set) => ({
  labels: {},
  put: (sessionId, label) =>
    set((state) => {
      const before = state.labels[sessionId];
      if (before && before.name === label.name && before.cwd === label.cwd) return state;
      return { labels: { ...state.labels, [sessionId]: { name: label.name, cwd: label.cwd } } };
    }),
}));
