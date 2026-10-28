import "../../../i18n/register-reply-tools.ts";
import { Button, Icon, IconQuote, useMediaQuery } from "@pap/ui";
import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { stripHidden } from "../../../lib/untrusted-text.ts";
import { useComposerInsert } from "../../../stores/composer-insert.ts";
import { useKnowledgeEnabled } from "../../../stores/knowledge-enabled.ts";
import { GUESS, knowledgeRequest, placeToolbar, quoteOf } from "./quote.vm.ts";
import { useQuoteSelection } from "./use-quote-selection.ts";

export const COARSE_POINTER = "(pointer: coarse)";

/** The selection must survive a press on the buttons. */
const keepSelection = (event: { preventDefault(): void }) => event.preventDefault();

/** QUOTE and TO KNOWLEDGE: both put text in the session's composer, and nothing is ever sent. */
export function QuoteButtons({ sessionId, text }: { readonly sessionId: string; readonly text: string }) {
  const t = useT();
  const knowledge = useKnowledgeEnabled((state) => state.enabled[sessionId] === true);
  const put = (insert: string) => {
    useComposerInsert.getState().push(sessionId, insert);
    document.getSelection()?.removeAllRanges();
  };
  return (
    <>
      <Button size="sm" onClick={() => put(quoteOf(stripHidden(text)))}>
        <Icon icon={IconQuote} size={14} />
        {t("reply.quote.quote")}
      </Button>
      {knowledge ? (
        <Button
          size="sm"
          onClick={() => put(knowledgeRequest(t("reply.quote.knowledgeRequest"), quoteOf(text)))}
        >
          {t("reply.quote.knowledge")}
        </Button>
      ) : null}
    </>
  );
}

/**
 * With a fine pointer, a small bar floats above (or below) the passage selected in an agent's reply (UX-1). Escape
 * clears the selection and with it the bar; the shortcut layer leaves that Escape to it (`overlayOpen`).
 */
export function QuoteToolbar({ sessionId }: { readonly sessionId: string }) {
  const t = useT();
  const coarse = useMediaQuery(COARSE_POINTER);
  const selection = useQuoteSelection(sessionId);
  const knowledge = useKnowledgeEnabled((state) => state.enabled[sessionId] === true);
  const bar = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>(GUESS);
  // The bar's real size (the French labels are wider): measured before paint, so the clamp uses it.
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const next = { width: element.offsetWidth || GUESS.width, height: element.offsetHeight || GUESS.height };
    setSize((before) => (before.width === next.width && before.height === next.height ? before : next));
  }, [selection, coarse, knowledge, t]);
  if (coarse || selection === null) return null;
  const place = placeToolbar(selection.rect, { width: window.innerWidth, height: window.innerHeight }, size);
  return (
    <div
      ref={bar}
      role="toolbar"
      data-quote-toolbar=""
      data-closes-on-escape=""
      aria-label={t("reply.quote.toolbar")}
      className="fixed z-40 flex w-max items-center gap-s1 rounded-md border border-border-strong bg-bg-side p-s1 shadow-overlay"
      style={{ left: place.left, top: place.top }}
      onMouseDown={keepSelection}
      onPointerDown={keepSelection}
    >
      <QuoteButtons sessionId={sessionId} text={selection.text} />
    </div>
  );
}
