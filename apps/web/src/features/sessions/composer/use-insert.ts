import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useComposerInsert } from "../../../stores/composer-insert.ts";
import { insertAt } from "../quote/quote.vm.ts";

/**
 * Puts what the reply tools queued for this session (QUOTE, TO KNOWLEDGE) into the composer field at its caret, or at
 * the end when it never had focus, moves the caret after it and focuses the field. Nothing is ever sent.
 */
export function useInsertInto(
  sessionId: string,
  field: RefObject<HTMLTextAreaElement | null> | undefined,
  text: string,
  commit: (next: string) => void,
): void {
  const n = useComposerInsert((state) => state.items[sessionId]?.n);
  const latest = useRef({ text, commit });
  const touched = useRef(false);
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    latest.current = { text, commit };
  });
  useEffect(() => {
    const element = field?.current;
    const note = () => {
      touched.current = true;
    };
    element?.addEventListener("focus", note);
    return () => element?.removeEventListener("focus", note);
  }, [field]);
  useEffect(() => {
    if (n === undefined) return;
    const insert = useComposerInsert.getState().take(sessionId);
    if (insert === null) return;
    const { text: current, commit: set } = latest.current;
    const caret = touched.current ? (field?.current?.selectionStart ?? current.length) : current.length;
    const next = insertAt(current, caret, insert);
    caretAfter.current = next.caret;
    set(next.text);
  }, [n, sessionId, field]);
  useEffect(() => {
    const caret = caretAfter.current;
    const element = field?.current;
    if (caret === null || !element) return;
    caretAfter.current = null;
    element.focus();
    element.setSelectionRange(caret, caret);
  }, [text, field]);
}
