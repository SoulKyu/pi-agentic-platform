import { EmptyState, IconButton, IconLists, IconSearch, Mark } from "@pap/ui";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { runCommand } from "../../features/commands/index.ts";
import {
  activeTab,
  itemFromPath,
  useWorkspaceStore,
  type ItemRef,
  type Tab,
} from "../../features/workspace/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { useCommand } from "../../lib/use-command.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { loadArchivedLanes } from "./archived-lanes.ts";
import { BottomNav, type MobileSection } from "./BottomNav.tsx";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { itemTitle } from "./item-title.ts";
import { useViewLabels } from "../../stores/view-labels-store.ts";
import { NotFound } from "./NotFound.tsx";
import { PaneHost } from "./PaneHost.tsx";
import { ProjectSwitcher } from "./ProjectSwitcher.tsx";
import { SurfaceSwitch, type SwitchChoice } from "./SurfaceSwitch.tsx";
import { useSurfaceView, viewOf, type SurfaceView } from "./surface-view.ts";
import { usePaletteChord } from "./shortcut.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";

// A separate chunk (it imports the overlay stack), fetched on first open and mounted only while open.
const loadTabSwitcher = () => import("./TabSwitcher.tsx");
const loadTree = () => import("../../features/projects/ProjectTree.tsx");

/** The item a session tab shows on a phone: its chat, or its split when the split is what the view names. */
function shownItem(tab: Tab, view: SurfaceView): ItemRef {
  const split = tab.split?.item;
  const wanted = { review: "changes", term: "terminal", files: "files", chat: "session" }[view];
  return split && split.kind === wanted ? split : tab.item;
}

const CHOICE: Readonly<Record<string, SwitchChoice | "files">> = {
  session: "chat",
  changes: "review",
  terminal: "term",
  files: "files",
};

/** Below 768 px (DESIGN.md §8): one pane at a time, the four sections in a bottom nav. No split, no rail. */
export function MobileShell() {
  const t = useT();
  const lazyText = useLazyFailureText();
  const chord = usePaletteChord();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tab = useWorkspaceStore((state) => activeTab(state.ws));
  const sessions = useShellStore((state) => state.view.sessions);
  const views = useViewLabels((state) => state.labels);
  const lanes = useLaneStore((state) => state.view);
  const view = useSurfaceView((state) => (tab ? viewOf(state, tab.key) : "chat"));
  const [section, setSection] = useState<MobileSection>("work");
  const [seenPath, setSeenPath] = useState(pathname);
  const [tabsOpen, setTabsOpen] = useState(false);
  // Going to an item (a link, the palette, a tab) shows it: adjust state while rendering, not in an effect.
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setSection("work");
  }
  // The Toaster is a sibling of the router, outside this tree: styles.css reads the layout from <html>.
  useEffect(() => {
    document.documentElement.dataset["shell"] = "mobile";
    return () => {
      delete document.documentElement.dataset["shell"];
    };
  }, []);
  // The home's "All sessions" on a phone: the Lists section, where the tree lives.
  useCommand("mobile.lists.open", () => setSection("lists"));
  const item = itemFromPath(pathname, import.meta.env.DEV);
  const title = item ? itemTitle(item, sessions, views, t, lanes) : t("shell.notFound.title");
  return (
    <div data-shell="mobile" className="flex h-app flex-col">
      <header className="flex h-bar shrink-0 items-center gap-s2 border-b border-border bg-bg-side px-s2">
        <Mark size={20} />
        <ProjectSwitcher />
        <span className="min-w-0 flex-1 truncate text-ui font-semibold">{title}</span>
        <IconButton
          icon={IconSearch}
          label={t("shell.top.palette")}
          onClick={() => void runCommand("palette.toggle")}
        />
        <IconButton icon={IconLists} label={t("shell.mobile.tabs")} onClick={() => setTabsOpen(true)} />
      </header>
      <ConnectionBanner />
      {/* The one main landmark: the screens inside it are sections. */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        {section === "agents" ? (
          <div className="p-s3">
            <EmptyState title={t("shell.agents.emptyTitle")} purpose={t("shell.agents.emptyPurpose")} />
          </div>
        ) : section === "lists" ? (
          <LazyPanel
            text={lazyText}
            load={loadTree}
            open={section === "lists"}
            props={{
              onPick: () => setSection("work"),
              onNewSession: () => setSection("work"),
              chord,
              loadArchivedLanes,
            }}
            onFailed={() => setSection("work")}
          />
        ) : section === "inbox" ? (
          <div className="p-s3">
            <EmptyState title={t("shell.inbox.emptyTitle")} purpose={t("shell.inbox.emptyPurpose")} />
          </div>
        ) : item ? (
          tab && tab.item.kind === "session" ? (
            <SessionSurface tab={tab} sessionId={tab.item.id} view={view} />
          ) : (
            <PaneHost tab={tab} />
          )
        ) : (
          <NotFound />
        )}
      </main>
      <BottomNav section={section} inboxCount={0} onSection={setSection} />
      <LazyPanel
        text={lazyText}
        load={loadTabSwitcher}
        open={tabsOpen}
        props={{ open: tabsOpen, onOpenChange: setTabsOpen }}
        onFailed={() => setTabsOpen(false)}
      />
    </div>
  );
}

/** The switch above the one pane a session tab shows. */
function SessionSurface({ tab, sessionId, view }: { tab: Tab; sessionId: string; view: SurfaceView }) {
  const shown = shownItem(tab, view);
  return (
    <div className="flex min-h-full flex-col">
      <SurfaceSwitch tabKey={tab.key} sessionId={sessionId} selected={CHOICE[shown.kind] ?? "chat"} />
      <PaneHost tab={tab} shown={shown} />
    </div>
  );
}
