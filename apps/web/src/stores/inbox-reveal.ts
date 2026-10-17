import { create } from "zustand";

interface InboxRevealState {
  /** The shell should open the Inbox (the drawer, or the phone's section) once it shows the page again. */
  readonly open: boolean;
  /** The row the opened Inbox should bring into view; null for the Inbox as a whole. */
  readonly itemId: string | null;
  ask(itemId: string | null): void;
  /** True once per request: the shell that opens the Inbox acts on it. */
  takeOpen(): boolean;
  /** The row asked for, once: the panel that shows it acts on it. */
  takeItem(): string | null;
  /** Sign-out: the next account starts from nothing. */
  clear(): void;
}

/** What a tapped notification asks of the Inbox: the landing cannot reach the shell or the panel (features never import routes). */
export const useInboxReveal = create<InboxRevealState>()((set, get) => ({
  open: false,
  itemId: null,
  ask: (itemId) => set({ open: true, itemId }),
  takeOpen: () => {
    const { open } = get();
    if (open) set({ open: false });
    return open;
  },
  takeItem: () => {
    const { itemId } = get();
    if (itemId !== null) set({ itemId: null });
    return itemId;
  },
  clear: () => set({ open: false, itemId: null }),
}));
