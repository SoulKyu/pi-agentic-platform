import { Button } from "@pap/ui";
import { useMemo, useState } from "react";
import { useT } from "../../../i18n/index.ts";
import { clip, plain, type ClipLimits } from "./untrusted.ts";

/** The display text of an untrusted string: stripped of invisible characters, clipped until the owner expands it. */
export function useClipped(raw: string, limits: ClipLimits) {
  const [expanded, setExpanded] = useState(false);
  const { clean, cut } = useMemo(() => {
    const text = plain(raw);
    return { clean: text, cut: clip(text, limits) };
  }, [raw, limits]);
  return {
    shown: expanded ? clean : cut.shown,
    clipped: cut.clipped,
    expanded,
    toggle: () => setExpanded((open) => !open),
  };
}

export function ExpandToggle(props: {
  readonly clipped: boolean;
  readonly expanded: boolean;
  toggle(): void;
}) {
  const t = useT();
  if (!props.clipped) return null;
  return (
    <div>
      <Button aria-expanded={props.expanded} onClick={props.toggle}>
        {t(props.expanded ? "dialog.less" : "dialog.more")}
      </Button>
    </div>
  );
}
