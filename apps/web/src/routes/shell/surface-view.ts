import { create } from "zustand";

/** What a phone shows of a session tab: its chat, or the item the tab is split with (M8R72). */
export type SurfaceView = "chat" | "review" | "term" | "files";

interface SurfaceViewState {
  readonly tabKey: string | null;
  readonly view: SurfaceView;
  show(tabKey: string, view: SurfaceView): void;
}

/** One entry only: the tab last switched. Any other tab starts on Chat, so nothing accumulates. */
export const useSurfaceView = create<SurfaceViewState>()((set) => ({
  tabKey: null,
  view: "chat",
  show: (tabKey, view) => set({ tabKey, view }),
}));

export const viewOf = (state: SurfaceViewState, tabKey: string): SurfaceView =>
  state.tabKey === tabKey ? state.view : "chat";

interface TerminalReadyState {
  readonly ready: boolean;
  set(ready: boolean): void;
}

/** True once the `terminal` stream gave its first snapshot: until then the list of terminals is unknown (MC32). */
export const useTerminalReady = create<TerminalReadyState>()((set) => ({
  ready: false,
  set: (ready) => set({ ready }),
}));
