import { useNavigate } from "@tanstack/react-router";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { useCommand } from "../../features/commands/index.ts";
import { activeTab, pathOfItem, useWorkspaceStore, type ItemRef } from "../../features/workspace/index.ts";
import { signOut } from "./sign-out.ts";
import { useTerminalReady } from "./surface-view.ts";
import { placeOf, showSurface, type Surface } from "./surface.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { reportClientIssue } from "../../lib/report.ts";
import { useAgentCommands } from "./agent-commands.ts";
import { closeItem, go, goToActive, toggleSplit, unsplitTab } from "./tab-actions.ts";

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

  useAgentCommands();
  useCommand("drawer.tree.toggle", () => {
    state.setInboxOpen(false);
    state.setTreeOpen((current) => !current);
  });
  useCommand("drawer.inbox.toggle", () => {
    state.setTreeOpen(false);
    state.setInboxOpen((current) => !current);
  });
  // A tapped notification names an Inbox item: open the drawer, never toggle it shut (M12).
  useCommand("drawer.inbox.open", () => {
    state.setTreeOpen(false);
    state.setInboxOpen(true);
  });
  // Palette commands on the active session tab; false when it is not one the shell store holds (nothing to show).
  const surface = (which: Surface) => () => {
    const tab = activeTab(useWorkspaceStore.getState().ws);
    if (!tab || tab.item.kind !== "session") return false;
    const place = placeOf(useShellStore.getState().view, tab.item.id);
    if (!place || (which === "terminal" ? place.cwd : place.root) === null) return false;
    if (which === "terminal" && !useTerminalReady.getState().ready) return false; // the stream has not answered yet
    showSurface(tab.key, tab.item.id, which).catch(() => reportClientIssue("command_failed"));
  };
  useCommand("session.showChanges", surface("changes"));
  useCommand("session.openTerminal", surface("terminal"));
  useCommand("session.showFiles", surface("files"));
  useCommand("settings.open", () => open({ kind: "settings", section: "appearance" }));
  useCommand("tasks.open", () => open({ kind: "tasks" }));
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
    const tab = activeTab(useWorkspaceStore.getState().ws);
    if (!tab) return false;
    return unsplitTab(tab.key) ? undefined : false;
  });
  useCommand("appearance.cycleMode", () => {
    const { account, setAccount } = useAppearanceStore.getState();
    const next = MODES[(MODES.indexOf(account.mode) + 1) % MODES.length] ?? "system";
    setAccount({ ...account, mode: next });
  });
  useCommand("auth.signOut", () => signOut(state.onSignedOut));
}
