import { create } from "zustand";
import { EMPTY_VIEW, reduceSession, type SessionView } from "./session-reducer.ts";

interface SessionStoreState {
  readonly views: Readonly<Record<string, SessionView>>;
  apply(sessionId: string, event: unknown): void;
}

export const useSessionStore = create<SessionStoreState>()((set) => ({
  views: {},
  apply: (sessionId, event) =>
    set((state) => ({
      views: { ...state.views, [sessionId]: reduceSession(state.views[sessionId] ?? EMPTY_VIEW, event) },
    })),
}));
