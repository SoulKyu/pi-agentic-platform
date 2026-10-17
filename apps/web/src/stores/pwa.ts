import { create } from "zustand";

interface PwaState {
  /** A newer copy of the page (the web shell, never a pap release) waits behind the one that is open. */
  readonly updateReady: boolean;
  /** The worker could not install (a proxy that redirects /sw.js, a 404): the page works, installed mode does not. */
  readonly registrationFailed: boolean;
  /** This device holds a push subscription made with another key: one tap re-enables it (M12R12). */
  readonly needsReenable: boolean;
  /** Hidden for this page load only (never stored): "Plus tard" on the update, "Masquer" on the failed worker. */
  readonly updateHidden: boolean;
  readonly failedHidden: boolean;
  readonly reenableHidden: boolean;
  readonly openHandler: ((path: string) => void) | null;
  readonly resubscribeHandler: (() => void) | null;
  markUpdateReady(): void;
  hideUpdate(): void;
  hideFailed(): void;
  hideReenable(): void;
  setRegistrationFailed(failed: boolean): void;
  setNeedsReenable(value: boolean): void;
  /** The worker's `open` message (a notification click on a window that is already open). Returns its unsubscribe. */
  onOpen(handler: (path: string) => void): () => void;
  /** The worker's `resubscribe` message (`pushsubscriptionchange`). Returns its unsubscribe. */
  onResubscribe(handler: () => void): () => void;
  /**
   * Sign-out (MC34): what belongs to the account. A waiting update and a failed worker are facts
   * about this page and this browser; the next account has the same ones.
   */
  reset(): void;
}

export const usePwa = create<PwaState>()((set, get) => ({
  updateReady: false,
  registrationFailed: false,
  needsReenable: false,
  updateHidden: false,
  failedHidden: false,
  reenableHidden: false,
  openHandler: null,
  resubscribeHandler: null,
  markUpdateReady: () => set({ updateReady: true }),
  hideUpdate: () => set({ updateHidden: true }),
  hideFailed: () => set({ failedHidden: true }),
  hideReenable: () => set({ reenableHidden: true }),
  setRegistrationFailed: (registrationFailed) => set({ registrationFailed }),
  setNeedsReenable: (needsReenable) => set({ needsReenable }),
  onOpen: (handler) => {
    set({ openHandler: handler });
    return () => {
      if (get().openHandler === handler) set({ openHandler: null });
    };
  },
  onResubscribe: (handler) => {
    set({ resubscribeHandler: handler });
    return () => {
      if (get().resubscribeHandler === handler) set({ resubscribeHandler: null });
    };
  },
  reset: () =>
    set({ needsReenable: false, reenableHidden: false, openHandler: null, resubscribeHandler: null }),
}));

/** What the page banner says now: the update, then the one-tap re-enable, then a worker that could not install. */
export function bannerKind(
  state: Pick<
    PwaState,
    | "updateReady"
    | "updateHidden"
    | "needsReenable"
    | "reenableHidden"
    | "registrationFailed"
    | "failedHidden"
  >,
): "update" | "reenable" | "failed" | null {
  if (state.updateReady && !state.updateHidden) return "update";
  if (state.needsReenable && !state.reenableHidden) return "reenable";
  if (state.registrationFailed && !state.failedHidden) return "failed";
  return null;
}
