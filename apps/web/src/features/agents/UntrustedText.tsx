import "./register-space-catalog.ts";
import { Button } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { foldLines, stripHidden } from "./untrusted-text.ts";

/**
 * Text that is not pap's own words (RT-18): React text, hidden characters stripped, folded past 16 lines until the owner
 * asks for the rest. The frame and the label around it are the caller's.
 */
export function UntrustedText({ text }: { readonly text: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const clean = stripHidden(text);
  const fold = foldLines(clean);
  return (
    <>
      <p className="whitespace-pre-wrap break-words font-mono text-code text-muted">
        {all || !fold.folded ? clean : fold.shown}
      </p>
      {fold.folded ? (
        <div>
          <Button size="sm" variant="ghost" aria-expanded={all} onClick={() => setAll((open) => !open)}>
            {all ? t("agentSpace.event.showLess") : t("agentSpace.event.showAll", { n: fold.total })}
          </Button>
        </div>
      ) : null}
    </>
  );
}
