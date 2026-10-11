import { useIsPhone } from "@pap/ui";
import { useRouterState } from "@tanstack/react-router";
import { useT } from "../../i18n/index.ts";
import { activeTab, itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { itemTitle } from "./item-title.ts";
import { NotFound } from "./NotFound.tsx";
import { PaneHost } from "./PaneHost.tsx";
import { Rail } from "./Rail.tsx";
import { useSessionsCache } from "./sessions-cache.ts";
import { TabBar } from "./TabBar.tsx";
import { TopBar } from "./TopBar.tsx";
import { useShellEffects } from "./use-shell-effects.ts";

interface AppShellProps {
  readonly username: string | null;
  readonly passkeysAvailable: boolean;
  onSignedOut(): void;
}

// The tree drawer arrives with Task 21, which reads its state here.
const treeClosed = () => false;

/** Desktop layout. The URL names the active item; Task 23 adds the phone branch. */
export function AppShell({ username, onSignedOut }: AppShellProps) {
  const t = useT();
  const mobile = useIsPhone();
  useShellEffects({ mobile, treeOpen: treeClosed });
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
