import { useNavigate } from "@tanstack/react-router";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { useCommand } from "../../features/commands/index.ts";
import { activeTab, pathOfItem, useWorkspaceStore, type ItemRef } from "../../features/workspace/index.ts";
import { signOut } from "./sign-out.ts";
import { closeItem, go, goToActive, toggleSplit } from "./tab-actions.ts";

type Setter = (open: boolean | ((open: boolean) => boolean)) => void;

interface ShellCommandState {
  readonly setTreeOpen: Setter;
  readonly setInboxOpen: Setter;
  readonly setHelpOpen: Setter;
  readonly mobile: boolean;
  onSignedOut(): void;
}

const MODES = ["system", "night", "day"] as const;

/** The commands the shell owns (Orca app-command-handlers.ts). A handler that returns false leaves the key to the browser. */
export function useShellCommands(state: ShellCommandState): void {
  const navigate = useNavigate();
  const open = (item: ItemRef) => go(navigate, pathOfItem(item));
  const hasTabs = () => useWorkspaceStore.getState().ws.tabs.length > 0;
  const step = (by: 1 | -1) => () => {
    if (!hasTabs()) return false;
    useWorkspaceStore.getState().cycle(by);
    goToActive(navigate);
  };

  useCommand("drawer.tree.toggle", () => {
    state.setInboxOpen(false);
    state.setTreeOpen((current) => !current);
  });
  useCommand("drawer.inbox.toggle", () => {
    state.setTreeOpen(false);
    state.setInboxOpen((current) => !current);
  });
  useCommand("settings.open", () => open({ kind: "settings", section: "appearance" }));
  useCommand("shortcuts.help", () => state.setHelpOpen(true));
  useCommand("session.new", () => open({ kind: "home" }));
  useCommand("tab.next", step(1));
  useCommand("tab.prev", step(-1));
  useCommand("tab.close", () => {
    const key = useWorkspaceStore.getState().ws.active;
    if (key === null) return false;
    closeItem(navigate, key);
  });
  useCommand("pane.split", () => (state.mobile ? false : toggleSplit()));
  useCommand("pane.close", () => {
    const store = useWorkspaceStore.getState();
    const tab = activeTab(store.ws);
    if (!tab?.split) return false;
    store.unsplit(tab.key);
  });
  useCommand("appearance.cycleMode", () => {
    const { account, setAccount } = useAppearanceStore.getState();
    const next = MODES[(MODES.indexOf(account.mode) + 1) % MODES.length] ?? "system";
    setAccount({ ...account, mode: next });
  });
  useCommand("auth.signOut", () => signOut(state.onSignedOut));
}
