import { Fence } from "@pap/ui";
import { useState } from "react";
import { plural, useLocale, useT } from "../../i18n/index.ts";
import { ExpandToggle } from "./dialogs/use-clipped.tsx";
import { pieces } from "./hidden-runs.ts";
import "./register-policy-catalog.ts";

const FENCE_LIMITS = { lines: 6, chars: 1200 } as const;

/**
 * A fenced part of a task's prompt, six lines until the owner asks for the rest. What the agent was given is what shows:
 * hidden characters are not drawn, but each run leaves a muted, counted marker, so invisible content is never silent.
 */
export function FencedPart({ source, text }: { source: string; text: string }) {
  const t = useT();
  const locale = useLocale();
  const [expanded, setExpanded] = useState(false);
  const view = pieces(text, FENCE_LIMITS, expanded);
  return (
    <>
      <Fence label={t("sessionPolicy.fence", { source })}>
        {view.pieces.map((piece, index) =>
          "hidden" in piece ? (
            <span
              key={index}
              data-hidden-marker=""
              role="note"
              aria-label={plural(locale, "sessionPolicy.fenceHidden", piece.hidden)}
              className="italic text-muted"
            >
              {`⟨${plural(locale, "sessionPolicy.fenceHidden", piece.hidden)}⟩`}
            </span>
          ) : (
            piece.text
          ),
        )}
      </Fence>
      <ExpandToggle clipped={view.clipped} expanded={expanded} toggle={() => setExpanded((open) => !open)} />
    </>
  );
}
