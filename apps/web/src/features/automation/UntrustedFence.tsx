import { Button, Fence } from "@pap/ui";
import { useState } from "react";
import { useT } from "../../i18n/index.ts";
import { shown } from "./board.vm.ts";
import { capped } from "./dry-run.vm.ts";

/**
 * Outside text in DESIGN §2's dashed frame, labelled with its source: React text only, hidden characters written out,
 * cut at a cap until the person asks for all of it.
 */
export function UntrustedFence({ source, text }: { readonly source: string; readonly text: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const view = capped(text, expanded);
  return (
    <>
      <Fence label={t("automation.card.fence", { source: shown(source, "name") })}>{view.shown}</Fence>
      {view.clipped ? (
        <div>
          <Button size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
            {t(expanded ? "automation.dry.showLess" : "automation.dry.showAll")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
