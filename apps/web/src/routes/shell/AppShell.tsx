import { useIsPhone } from "@pap/ui";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectPlatform } from "../../features/commands/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { activeTab, itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { itemTitle } from "./item-title.ts";
import { MobileShell } from "./MobileShell.tsx";
import { NotFound } from "./NotFound.tsx";
import { PaletteHost } from "./PaletteHost.tsx";
import { PaneHost } from "./PaneHost.tsx";
import { Rail } from "./Rail.tsx";
import { ShellContext } from "./shell-context.ts";
import { useSessionsCache } from "./sessions-cache.ts";
import { useShellCommands } from "./shell-commands.ts";
import { TabBar } from "./TabBar.tsx";
import { TopBar } from "./TopBar.tsx";
import { useShellEffects } from "./use-shell-effects.ts";
import { useViewportHeight } from "./use-viewport-height.ts";

interface AppShellProps {
  readonly username: string | null;
  readonly passkeysAvailable: boolean;
  onSignedOut(): void;
}

// Each is its own chunk (they import the overlay stack), fetched on first open and mounted only while open.
const loadTreeDrawer = () => import("./TreeDrawer.tsx");
const loadInboxDrawer = () => import("./InboxDrawer.tsx");
const loadShortcutsHelp = () => import("../../features/commands/ShortcutsHelp.tsx");

/** The URL names the active item. Desktop: rail, tabs and split panes; below 768 px: one pane and a bottom nav. */
export function AppShell({ username, passkeysAvailable, onSignedOut }: AppShellProps) {
  const mobile = useIsPhone();
  const lazyText = useLazyFailureText();
  const [treeOpen, setTreeOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // The dispatcher reads the tree state at each key (`treeOpen`, M3-RT-30), so Ctrl+B can close the drawer it opened.
  const treeRef = useRef(false);
  useEffect(() => {
    treeRef.current = treeOpen;
  }, [treeOpen]);
  const readTreeOpen = useCallback(() => treeRef.current, []);
  const shell = useMemo(
    () => ({ username, passkeysAvailable, onSignedOut }),
    [username, passkeysAvailable, onSignedOut],
  );
  useViewportHeight();
  useShellEffects({ mobile, treeOpen: readTreeOpen });
  useShellCommands({ setTreeOpen, setInboxOpen, setHelpOpen, mobile, onSignedOut });
  return (
    <ShellContext.Provider value={shell}>
      {mobile ? <MobileShell /> : <DesktopShell username={username} onSignedOut={onSignedOut} />}
      <PaletteHost />
      <LazyPanel
        text={lazyText}
        load={loadTreeDrawer}
        open={treeOpen}
        props={{ open: treeOpen, onOpenChange: setTreeOpen }}
        onFailed={() => setTreeOpen(false)}
      />
      <LazyPanel
        text={lazyText}
        load={loadInboxDrawer}
        open={inboxOpen}
        props={{ open: inboxOpen, onOpenChange: setInboxOpen }}
        onFailed={() => setInboxOpen(false)}
      />
      <LazyPanel
        text={lazyText}
        load={loadShortcutsHelp}
        open={helpOpen}
        props={{ open: helpOpen, onOpenChange: setHelpOpen, platform: detectPlatform() }}
        onFailed={() => setHelpOpen(false)}
      />
    </ShellContext.Provider>
  );
}

function DesktopShell({ username, onSignedOut }: Pick<AppShellProps, "username" | "onSignedOut">) {
  const t = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tab = useWorkspaceStore((state) => activeTab(state.ws));
  const sessions = useSessionsCache((state) => state.sessions);
  const item = itemFromPath(pathname, import.meta.env.DEV);
  const title = item ? itemTitle(item, sessions, t) : t("shell.notFound.title");
  return (
    <div data-shell="desktop" className="flex h-app rail-right:flex-row-reverse">
      <Rail username={username} onSignedOut={onSignedOut} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} />
        <TabBar />
        <ConnectionBanner />
        {/* Not <main>: M2's screens carry their own <main> until P3 turns them into sections. */}
        <div id="pane-host" className="flex min-h-0 flex-1">
          {item ? <PaneHost tab={tab} /> : <NotFound />}
        </div>
      </div>
    </div>
  );
}
