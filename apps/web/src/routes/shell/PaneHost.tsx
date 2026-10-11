import { useT } from "../../i18n/index.ts";
import type { Tab } from "../../features/workspace/index.ts";
import { itemTitle } from "./item-title.ts";
import { PaneBoundary } from "./PaneBoundary.tsx";
import { renderItem } from "./pane-renderers.tsx";
import { useSessionsCache } from "./sessions-cache.ts";

/** The active tab's pane, named after its item (a session by its folder, once the sessions cache has it). */
export function PaneHost({ tab }: { readonly tab: Tab | null }) {
  const t = useT();
  const sessions = useSessionsCache((state) => state.sessions);
  if (!tab) return null;
  return (
    <section
      key={tab.key}
      data-pane-kind={tab.item.kind}
      aria-label={itemTitle(tab.item, sessions, t)}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <PaneBoundary key={tab.key}>{renderItem(tab.item)}</PaneBoundary>
    </section>
  );
}
