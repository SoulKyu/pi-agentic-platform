import { useRouterState } from "@tanstack/react-router";
import { AccountBar } from "../../features/auth/AccountBar.tsx";
import { activeTab, itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";
import { ConnectionBanner } from "./ConnectionBanner.tsx";
import { NotFound } from "./NotFound.tsx";
import { PaneHost } from "./PaneHost.tsx";
import { useShellEffects } from "./use-shell-effects.ts";

interface AppShellProps {
  readonly username: string | null;
  readonly passkeysAvailable: boolean;
  onSignedOut(): void;
}

/** Desktop layout. The URL names the active item; Task 19b swaps AccountBar for the rail and top bar, Task 23 adds the phone branch. */
export function AppShell({ username, passkeysAvailable, onSignedOut }: AppShellProps) {
  useShellEffects();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const tab = useWorkspaceStore((state) => activeTab(state.ws));
  const item = itemFromPath(pathname, import.meta.env.DEV);
  return (
    <div data-shell="desktop" className="flex h-app flex-col">
      <AccountBar username={username} passkeysAvailable={passkeysAvailable} onSignedOut={onSignedOut} />
      <ConnectionBanner />
      {/* Not <main>: M2's screens carry their own <main> until P3 turns them into sections. */}
      <div id="pane-host" className="flex min-h-0 flex-1">
        {item ? <PaneHost tab={tab} /> : <NotFound />}
      </div>
    </div>
  );
}
