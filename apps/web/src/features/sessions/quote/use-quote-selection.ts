import { useEffect, useState } from "react";
import { stripHidden } from "../../../lib/untrusted-text.ts";

export interface QuoteSelection {
  readonly text: string;
  readonly rect: DOMRect;
}

const MESSAGE = 'article[data-slot="message"][data-author="agent"]';
const BODY = '[data-markdown-body], [data-markdown-plain], [data-slot="markdown"]';

const elementOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement);

/** The agent message both ends of the range lie in, inside its Markdown, on this session's screen; null otherwise. */
function messageOf(range: Range, sessionId: string): Element | null {
  const start = elementOf(range.startContainer);
  const end = elementOf(range.endContainer);
  const message = start?.closest(MESSAGE) ?? null;
  if (!start || !end || message === null || end.closest(MESSAGE) !== message) return null;
  if (!start.closest(BODY) || !end.closest(BODY)) return null;
  const screen = message.closest("[data-session-screen]");
  return screen?.getAttribute("data-session-screen") === sessionId ? message : null;
}

function read(sessionId: string): QuoteSelection | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (messageOf(range, sessionId) === null) return null;
  const text = stripHidden(selection.toString());
  if (text.trim() === "") return null;
  return { text, rect: range.getBoundingClientRect() };
}

const same = (a: QuoteSelection | null, b: QuoteSelection | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.text === b.text &&
    a.rect.left === b.rect.left &&
    a.rect.top === b.rect.top &&
    a.rect.right === b.rect.right &&
    a.rect.bottom === b.rect.bottom);

/**
 * The passage selected inside one agent message of this session's screen (UX-1), computed on `selectionchange`. While
 * there is one, Escape (caught first, at the document) clears the selection and so closes the toolbar or strip; the
 * shortcut dispatcher already leaves that Escape alone, so the run is not stopped. The next Escape stops it as before.
 */
export function useQuoteSelection(sessionId: string): QuoteSelection | null {
  const [selected, setSelected] = useState<QuoteSelection | null>(null);
  useEffect(() => {
    const update = () => {
      const now = read(sessionId);
      setSelected((before) => (same(before, now) ? before : now));
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [sessionId]);
  const showing = selected !== null;
  useEffect(() => {
    if (!showing) return;
    const reread = () => setSelected(read(sessionId));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") document.getSelection()?.removeAllRanges();
    };
    document.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("scroll", reread, { capture: true, passive: true });
    window.addEventListener("resize", reread);
    return () => {
      document.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("scroll", reread, { capture: true });
      window.removeEventListener("resize", reread);
    };
  }, [showing, sessionId]);
  return selected;
}
