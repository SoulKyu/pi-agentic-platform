import "../../../i18n/register-reply-tools.ts";
import { useMediaQuery } from "@pap/ui";
import { useT } from "../../../i18n/index.ts";
import { COARSE_POINTER, QuoteButtons } from "./QuoteToolbar.tsx";
import { useQuoteSelection } from "./use-quote-selection.ts";

/** With a coarse pointer the same two buttons sit above the composer while a passage is selected (UX-1). */
export function QuoteStrip({ sessionId }: { readonly sessionId: string }) {
  const t = useT();
  const coarse = useMediaQuery(COARSE_POINTER);
  const selection = useQuoteSelection(sessionId);
  if (!coarse || selection === null) return null;
  return (
    <div
      role="toolbar"
      data-quote-strip=""
      data-closes-on-escape=""
      aria-label={t("reply.quote.toolbar")}
      className="flex items-center gap-s2"
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
    >
      <QuoteButtons sessionId={sessionId} text={selection.text} />
    </div>
  );
}
