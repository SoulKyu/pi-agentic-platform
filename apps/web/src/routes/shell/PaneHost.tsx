import { useT } from "../../i18n/index.ts";
import type { Tab } from "../../features/workspace/index.ts";
import { itemTitle } from "./item-title.ts";
import { PaneBoundary } from "./PaneBoundary.tsx";
import { renderItem } from "./pane-renderers.tsx";

/** The active tab's pane. Session titles come with the sessions cache (a later task); until then a session reads "Session". */
export function PaneHost({ tab }: { readonly tab: Tab | null }) {
  const t = useT();
  if (!tab) return null;
  return (
    <section
      key={tab.key}
      data-pane-kind={tab.item.kind}
      aria-label={itemTitle(tab.item, [], t)}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <PaneBoundary key={tab.key}>{renderItem(tab.item)}</PaneBoundary>
    </section>
  );
}
