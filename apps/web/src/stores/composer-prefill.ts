import { useEffect, type RefObject } from "react";
import { create } from "zustand";

/** What waits for a composer is clipped here; the draft cap clips the rest when it is taken. */
export const MAX_PREFILL_CHARS = 200_000;

interface PrefillState {
  readonly items: Readonly<Record<string, { readonly n: number; readonly text: string }>>;
  /** Puts a text aside for that session's composer; two texts waiting join with a blank line. */
  push(sessionId: string, text: string): void;
  /** The waiting text, once: the composer that takes it acts on it. */
  take(sessionId: string): string | null;
}

let counter = 0;

/** Text that comes from another part of the app (the review's batch) and goes after the draft of a composer. */
export const useComposerPrefill = create<PrefillState>()((set, get) => ({
  items: {},
  push(sessionId, text) {
    const waiting = get().items[sessionId]?.text;
    const joined = waiting === undefined ? text : `${waiting}\n\n${text}`;
    set({
      items: { ...get().items, [sessionId]: { n: ++counter, text: joined.slice(0, MAX_PREFILL_CHARS) } },
    });
  },
  take(sessionId) {
    const entry = get().items[sessionId];
    if (!entry) return null;
    set({ items: Object.fromEntries(Object.entries(get().items).filter(([id]) => id !== sessionId)) });
    return entry.text;
  },
}));

/** The draft with the text after it and a blank line between; an empty draft is not kept. */
export function appendDraft(draft: string, text: string): string {
  const kept = draft.trim() === "" ? "" : draft.replace(/\n+$/, "");
  return kept === "" ? text : `${kept}\n\n${text}`;
}

const focusMessage = (sessionId: string): void => {
  for (const screen of document.querySelectorAll<HTMLElement>("[data-session-screen]"))
    if (screen.dataset.sessionScreen === sessionId)
      screen.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus();
};

/** The composer's side: a waiting text goes after what is typed, once, and the field takes the focus. */
export function usePrefillInto(
  sessionId: string,
  text: RefObject<string>,
  commit: (next: string) => void,
): void {
  const waiting = useComposerPrefill((state) => state.items[sessionId]?.n);
  useEffect(() => {
    if (waiting === undefined) return;
    const prefill = useComposerPrefill.getState().take(sessionId);
    if (prefill === null) return;
    commit(appendDraft(text.current, prefill));
    focusMessage(sessionId);
  }, [waiting, sessionId, text, commit]);
}
