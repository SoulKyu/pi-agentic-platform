import { create } from "zustand";
import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { EMPTY_INBOX, type InboxView, reduceInbox } from "./inbox-reducer.ts";

interface InboxStoreState {
  readonly view: InboxView;
  apply(event: unknown): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

/** The owner's Inbox (the `inbox` stream): the counts the top bar shows, and the items the drawer lists. Eager, so the badge is live. */
export const useInboxStore = create<InboxStoreState>()((set) => ({
  view: EMPTY_INBOX,
  apply: (event) => set((state) => ({ view: reduceInbox(state.view, event) })),
  reset: () => set({ view: EMPTY_INBOX }),
}));

/** The one listener of the `inbox` stream while the shell is mounted. Its key is local: the stream is the caller's. */
export function feedInbox(
  subscriptions: Runtime["subscriptions"],
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe("inbox", "me", (event) => useInboxStore.getState().apply(event), onError);
}
