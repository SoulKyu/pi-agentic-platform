import type { HistoryMeta, TranscriptRow } from "@pap/contracts";
import { create } from "zustand";
import { prependHistory } from "./history.ts";
import { useViewLabels } from "./view-labels-store.ts";
import { EMPTY_VIEW, reduceSession, type SessionView } from "./session-reducer.ts";

interface SessionStoreState {
  readonly views: Readonly<Record<string, SessionView>>;
  apply(sessionId: string, event: unknown): void;
  /** Puts an older page above the view it was asked for; the page is dropped if the view changed since (M2-RT-12). */
  prependHistory(
    sessionId: string,
    page: HistoryMeta & { rows: readonly TranscriptRow[] },
    asked: { readonly generation: number; readonly oldestEntryId: string | null },
  ): void;
}

export const useSessionStore = create<SessionStoreState>()((set) => ({
  views: {},
  apply: (sessionId, event) => {
    set((state) => ({
      views: { ...state.views, [sessionId]: reduceSession(state.views[sessionId] ?? EMPTY_VIEW, event) },
    }));
    const view = useSessionStore.getState().views[sessionId];
    if (view?.loaded) useViewLabels.getState().put(sessionId, { name: view.name, cwd: view.cwd });
  },
  prependHistory: (sessionId, page, asked) =>
    set((state) => {
      const view = state.views[sessionId];
      if (!view) return state;
      const next = prependHistory(view, page, asked);
      return next === view ? state : { views: { ...state.views, [sessionId]: next } };
    }),
}));
