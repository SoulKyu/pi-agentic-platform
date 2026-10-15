import { useIsPhone } from "@pap/ui";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectPlatform } from "../../features/commands/index.ts";
import { useLazyFailureText } from "../../i18n/index.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { activeTab, itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedLanes } from "../../stores/lane-feed.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { feedShell } from "../../stores/shell-feed.ts";
import { resetFolderMemory } from "../../features/files/folder-memory.ts";
import { feedInbox, useInboxStore } from "../../stores/inbox-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { useUsageStore } from "../../stores/usage-store.ts";
import { resetUnsavedFiles } from "../../stores/unsaved-files.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { AddProjectHost } from "./AddProjectHost.tsx";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { MobileShell } from "./MobileShell.tsx";
import { NewLaneHost } from "./NewLaneHost.tsx";
import { NotFound } from "./NotFound.tsx";
import { PaletteHost } from "./PaletteHost.tsx";
import { PaneHost } from "./PaneHost.tsx";
import { Rail } from "./Rail.tsx";
import { ShellContext } from "./shell-context.ts";
import { StepUpHost } from "./StepUpHost.tsx";
import { useShellCommands } from "./shell-commands.ts";
import { TabBar } from "./TabBar.tsx";
import { TopBar } from "./TopBar.tsx";
import { useShellEffects } from "./use-shell-effects.ts";
import { useViewLabels } from "../../stores/view-labels-store.ts";
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
  // The one reader of the `shell` stream while the shell is mounted; the next account starts from nothing.
  useEffect(() => {
    const stop = feedShell(getRuntime().subscriptions, () => reportClientIssue("shell_feed_failed"));
    const stopLanes = feedLanes(getRuntime().subscriptions, () => reportClientIssue("lane_feed_failed"));
    const stopInbox = feedInbox(getRuntime().subscriptions, () => reportClientIssue("inbox_feed_failed"));
    return () => {
      stop();
      stopLanes();
      stopInbox();
      useLaneStore.getState().reset();
      useInboxStore.getState().reset();
      useShellStore.getState().reset();
      useViewLabels.setState({ labels: {} });
      // Every M8 client store (MC34). Uploads keep no state beyond their own component; the terminal store's reset
      // also clears the per-account maps of `surface-terminal.ts` when that chunk is loaded.
      useVcsStore.getState().reset();
      useTerminalStore.getState().reset();
      useTasksStore.getState().reset();
      useUsageStore.getState().reset();
      resetUnsavedFiles();
      useComposerPrefill.setState({ items: {} });
      useTriggerPrefill.setState({ items: {} });
      useAddProjectRequest.getState().close();
      usePaletteRequest.setState({ search: null });
      resetFolderMemory();
    };
  }, []);
  useShellEffects({ mobile, treeOpen: readTreeOpen });
  useShellCommands({ setTreeOpen, setInboxOpen, setHelpOpen, mobile, onSignedOut });
  return (
    <ShellContext.Provider value={shell}>
      <StepUpHost>
        {mobile ? <MobileShell /> : <DesktopShell username={username} onSignedOut={onSignedOut} />}
        <PaletteHost />
        <NewLaneHost />
        <AddProjectHost />
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
      </StepUpHost>
    </ShellContext.Provider>
  );
}

function DesktopShell({ username, onSignedOut }: Pick<AppShellProps, "username" | "onSignedOut">) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tab = useWorkspaceStore((state) => activeTab(state.ws));
  const item = itemFromPath(pathname, import.meta.env.DEV);
  return (
    <div data-shell="desktop" className="flex h-app rail-right:flex-row-reverse">
      <Rail username={username} onSignedOut={onSignedOut} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <TabBar />
        <ConnectionBanner />
        {/* The one main landmark: the screens inside it are sections. */}
        <main id="pane-host" className="flex min-h-0 flex-1">
          {item ? <PaneHost tab={tab} /> : <NotFound />}
        </main>
      </div>
    </div>
  );
}
