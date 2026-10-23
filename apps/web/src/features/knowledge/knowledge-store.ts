import { create } from "zustand";

/** `live`: its worker ran when the chip was clicked (the enable applies from its next start); `lane`: it works in a worktree. */
export interface KnowledgeOrigin {
  readonly sessionId: string;
  readonly live: boolean;
  readonly lane: boolean;
}

interface KnowledgeState {
  /** Per project: how many times OKF was enabled in this browser. Open chips and the row read again when it moves. */
  readonly versions: Readonly<Record<string, number>>;
  /** Sessions whose worker started before OKF was enabled: it applies from their next start. */
  readonly pending: Readonly<Record<string, true>>;
  /** Per project: the session whose NO OKF chip was clicked last, until the project page is left. */
  readonly origin: Readonly<Record<string, KnowledgeOrigin>>;
  bump(projectId: string): void;
  setOrigin(projectId: string, origin: KnowledgeOrigin): void;
  clearOrigin(projectId: string): void;
  markPending(sessionId: string): void;
  clearPending(sessionId: string): void;
}

export const useKnowledgeStore = create<KnowledgeState>()((set) => ({
  versions: {},
  pending: {},
  origin: {},
  setOrigin: (projectId, origin) => set((state) => ({ origin: { ...state.origin, [projectId]: origin } })),
  clearOrigin: (projectId) =>
    set((state) => ({
      origin: Object.fromEntries(Object.entries(state.origin).filter(([id]) => id !== projectId)),
    })),
  bump: (projectId) =>
    set((state) => ({ versions: { ...state.versions, [projectId]: (state.versions[projectId] ?? 0) + 1 } })),
  markPending: (sessionId) => set((state) => ({ pending: { ...state.pending, [sessionId]: true } })),
  clearPending: (sessionId) =>
    set((state) => ({
      pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== sessionId)),
    })),
}));
