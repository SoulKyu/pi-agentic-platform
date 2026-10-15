import { Collapsible } from "@pap/ui";
import { useId, useState, type ComponentType } from "react";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";

export interface ArchivedLanesProps {
  readonly count: number;
  onPick(id: string): void;
}

interface EntryProps {
  readonly count: number;
  /** The shell hands over the list's chunk: features do not import each other. */
  readonly load: () => Promise<{ default: ComponentType<ArchivedLanesProps> }>;
  onPick(id: string): void;
}

/** "Archived lanes (n)": the archive shelf of the tree (decision 30). The list loads on first open. */
export function ArchivedLanesEntry({ count, load, onPick }: EntryProps) {
  const t = useT();
  const text = useLazyFailureText();
  const [open, setOpen] = useState(false);
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} data-archived-lanes className="flex flex-col gap-s1">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        trigger={
          <span id={titleId} className="label-hud text-muted">
            {t("sidebar.lanesArchived", { count })}
          </span>
        }
      >
        <LazyPanel
          text={text}
          load={load}
          open={open}
          props={{ count, onPick }}
          onFailed={() => setOpen(false)}
        />
      </Collapsible>
    </section>
  );
}
