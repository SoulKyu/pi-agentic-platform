import type { Role } from "@pap/contracts";
import { useIsPhone } from "@pap/ui";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectPlatform } from "../../features/commands/index.ts";
import { useLazyFailureText, useT } from "../../i18n/index.ts";
import { RoleContext, useRole } from "../../lib/role-context.ts";
import { LazyPanel } from "../../lib/LazyPanel.tsx";
import { activeTab, itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";
import { feedAgents, useAgentsStore } from "../../stores/agents-store.ts";
import { feedLaunches } from "../../stores/launch-feed.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { feedLanes } from "../../stores/lane-feed.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { feedShell } from "../../stores/shell-feed.ts";
import { resetFolderMemory } from "../../features/files/folder-memory.ts";
import { useInboxReveal } from "../../stores/inbox-reveal.ts";
import { feedInbox, useInboxStore } from "../../stores/inbox-store.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { useAddProjectRequest } from "../../stores/add-project-request.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";
import { useTriggerPrefill } from "../../stores/trigger-prefill.ts";
import { bannerKind, usePwa } from "../../stores/pwa.ts";
import { useUsageStore } from "../../stores/usage-store.ts";
import { resetUnsavedFiles } from "../../stores/unsaved-files.ts";
import { useVcsStore } from "../../stores/vcs-store.ts";
import { AddProjectHost } from "./AddProjectHost.tsx";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { MobileShell } from "./MobileShell.tsx";
import { NewAgentHost } from "./NewAgentHost.tsx";
import { NewLaneHost } from "./NewLaneHost.tsx";
import { PaletteHost } from "./PaletteHost.tsx";
import { PaneHost } from "./PaneHost.tsx";
import { ProjectSettingsHost } from "./ProjectSettingsHost.tsx";
import { Rail } from "./Rail.tsx";
import { SecretDialogHost } from "./SecretDialogHost.tsx";
import { ShellContext } from "./shell-context.ts";
import { StepUpHost } from "./StepUpHost.tsx";
import { useShellCommands } from "./shell-commands.ts";
import { TabBar } from "./TabBar.tsx";
import { Unrouted } from "./Unrouted.tsx";
import { TopBar } from "./TopBar.tsx";
import { useShellEffects } from "./use-shell-effects.ts";
import { useViewLabels } from "../../stores/view-labels-store.ts";
import { useViewportHeight } from "./use-viewport-height.ts";

interface AppShellProps {
  readonly username: string | null;
  readonly role: Role;
  readonly passkeysAvailable: boolean;
  onSignedOut(): void;
}

// Each is its own chunk (they import the overlay stack), fetched on first open and mounted only while open.
const loadTreeDrawer = () => import("./TreeDrawer.tsx");
const loadInboxDrawer = () => import("./InboxDrawer.tsx");
const loadShortcutsHelp = () => import("../../features/commands/ShortcutsHelp.tsx");
const loadUpdateBanner = () => import("./UpdateBanner.tsx");

const noop = () => {};

/** The URL names the active item. Desktop: rail, tabs and split panes; below 768 px: one pane and a bottom nav. */
export function AppShell({ username, role, passkeysAvailable, onSignedOut }: AppShellProps) {
  const mobile = useIsPhone();
  const lazyText = useLazyFailureText();
  const [treeOpen, setTreeOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const updateShown = usePwa((state) => bannerKind(state) !== null);
  // The dispatcher reads the tree state at each key (`treeOpen`, M3-RT-30), so Ctrl+B can close the drawer it opened.
  const treeRef = useRef(false);
  useEffect(() => {
    treeRef.current = treeOpen;
  }, [treeOpen]);
  const readTreeOpen = useCallback(() => treeRef.current, []);
  const shell = useMemo(
    () => ({ username, role, passkeysAvailable, onSignedOut }),
    [username, role, passkeysAvailable, onSignedOut],
  );
  useViewportHeight();
  // The one reader of the `shell` stream while the shell is mounted; the next account starts from nothing.
  useEffect(() => {
    const stop = feedShell(getRuntime().subscriptions, () => reportClientIssue("shell_feed_failed"));
    const stopLanes = feedLanes(getRuntime().subscriptions, () => reportClientIssue("lane_feed_failed"));
    const stopInbox = feedInbox(getRuntime().subscriptions, () => reportClientIssue("inbox_feed_failed"));
    const stopAgents = feedAgents(getRuntime().subscriptions, () => reportClientIssue("agents_feed_failed"));
    const stopLaunches = feedLaunches(getRuntime().subscriptions);
    return () => {
      stop();
      stopLaunches();
      stopLanes();
      stopInbox();
      stopAgents();
      useLaneStore.getState().reset();
      useInboxStore.getState().reset();
      useAgentsStore.getState().reset();
      useLaunchStore.getState().reset();
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
      useSecretDialog.getState().close();
      usePwa.getState().reset();
      useInboxReveal.getState().clear();
      usePaletteRequest.setState({ search: null });
      resetFolderMemory();
    };
  }, []);
  useShellEffects({ mobile, role, treeOpen: readTreeOpen });
  useShellCommands({ setTreeOpen, setInboxOpen, setHelpOpen, mobile, role, onSignedOut });
  return (
    <ShellContext.Provider value={shell}>
      <RoleContext.Provider value={role}>
        <StepUpHost>
          {mobile ? <MobileShell /> : <DesktopShell username={username} onSignedOut={onSignedOut} />}
          <PaletteHost />
          <NewLaneHost />
          <NewAgentHost />
          <AddProjectHost />
          <ProjectSettingsHost />
          <SecretDialogHost />
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
          <LazyPanel text={lazyText} load={loadUpdateBanner} open={updateShown} props={{}} onFailed={noop} />
          <LazyPanel
            text={lazyText}
            load={loadShortcutsHelp}
            open={helpOpen}
            props={{ open: helpOpen, onOpenChange: setHelpOpen, platform: detectPlatform() }}
            onFailed={() => setHelpOpen(false)}
          />
        </StepUpHost>
      </RoleContext.Provider>
    </ShellContext.Provider>
  );
}

/** The first stop of the Tab order: it jumps over the rail and the tab strip to the pane. */
function SkipLink() {
  const t = useT();
  return (
    <a
      href="#pane-host"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById("pane-host")?.focus();
      }}
      className="sr-only focus:not-sr-only focus:absolute focus:left-s2 focus:top-s2 focus:z-50 focus:bg-surface focus:px-s3 focus:py-s2 focus:text-ui focus:text-fg focus-ring"
    >
      {t("shell.skip")}
    </a>
  );
}

function DesktopShell({ username, onSignedOut }: Pick<AppShellProps, "username" | "onSignedOut">) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tab = useWorkspaceStore((state) => activeTab(state.ws));
  const item = itemFromPath(pathname, import.meta.env.DEV, useRole());
  return (
    <div data-shell="desktop" className="flex h-app rail-right:flex-row-reverse">
      <SkipLink />
      <Rail username={username} onSignedOut={onSignedOut} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <TabBar />
        <ConnectionBanner />
        {/* The one main landmark: the screens inside it are sections. */}
        <main id="pane-host" tabIndex={-1} className="flex min-h-0 flex-1">
          {item ? <PaneHost tab={tab} /> : <Unrouted />}
        </main>
      </div>
    </div>
  );
}
