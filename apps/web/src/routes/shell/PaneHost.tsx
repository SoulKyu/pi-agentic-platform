import { Button, IconButton, IconClose } from "@pap/ui";
import { lazy, Suspense, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { SplitView, useWorkspaceStore, type ItemRef, type Tab } from "../../features/workspace/index.ts";
import { itemTitle } from "./item-title.ts";
import { PaneBoundary } from "./PaneBoundary.tsx";
import { renderItem } from "./pane-renderers.tsx";
import { useSessionsCache } from "./sessions-cache.ts";

// The menu stack is a separate chunk, fetched on the first press of "Show in this pane".
const LazyMenu = lazy(() => import("@pap/ui/overlays").then((module) => ({ default: module.Menu })));

/** The active tab's pane (named by its tab), beside its split item when it has one. */
export function PaneHost({ tab }: { readonly tab: Tab | null }) {
  const t = useT();
  const sessions = useSessionsCache((state) => state.sessions);
  const setRatio = useWorkspaceStore((state) => state.setRatio);
  if (!tab) return null;
  const main = (
    <section
      key={tab.key}
      id="pane-main"
      role="tabpanel"
      aria-labelledby={`tab-${tab.key}`}
      data-pane-kind={tab.item.kind}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <PaneBoundary key={tab.key}>{renderItem(tab.item)}</PaneBoundary>
    </section>
  );
  if (!tab.split) return main;
  const { item } = tab.split;
  return (
    <SplitView
      ratio={tab.split.ratio}
      onRatio={(ratio) => setRatio(tab.key, ratio)}
      label={t("shell.pane.separator")}
      first={main}
      second={
        <section
          key={`${tab.key}/split`}
          data-pane-role="split"
          data-pane-kind={item.kind}
          aria-label={itemTitle(item, sessions, t)}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <SplitHeader tab={tab} title={itemTitle(item, sessions, t)} />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <PaneBoundary key={`${tab.key}/${item.kind}`}>{renderItem(item)}</PaneBoundary>
          </div>
        </section>
      }
    />
  );
}

function SplitHeader({ tab, title }: { readonly tab: Tab; readonly title: string }) {
  const t = useT();
  const ws = useWorkspaceStore((state) => state.ws);
  const sessions = useSessionsCache((state) => state.sessions);
  const split = useWorkspaceStore((state) => state.split);
  const unsplit = useWorkspaceStore((state) => state.unsplit);
  const [menuAsked, setMenuAsked] = useState(false);
  const choices: readonly ItemRef[] = ws.tabs
    .filter((other) => other.key !== tab.key)
    .map((other) => other.item);
  const choose = (
    <Button variant="ghost" size="sm" aria-label={t("shell.pane.choose")} onClick={() => setMenuAsked(true)}>
      {t("shell.pane.choose")}
    </Button>
  );
  return (
    <div className="flex h-bar shrink-0 items-center gap-s2 border-b border-border bg-bg-side px-s2">
      <span className="min-w-0 flex-1 truncate text-ui font-semibold">{title}</span>
      {menuAsked ? (
        <Suspense fallback={choose}>
          <LazyMenu
            defaultOpen
            label={t("shell.pane.choose")}
            closeLabel={t("ui.close")}
            trigger={choose}
            items={choices.map((item) => ({
              id: JSON.stringify(item),
              label: itemTitle(item, sessions, t),
              onSelect: () => split(tab.key, item),
            }))}
          />
        </Suspense>
      ) : (
        choose
      )}
      <IconButton icon={IconClose} label={t("shell.tabs.unsplit")} onClick={() => unsplit(tab.key)} />
    </div>
  );
}
