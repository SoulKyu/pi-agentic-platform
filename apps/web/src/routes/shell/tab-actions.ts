import type { useNavigate } from "@tanstack/react-router";
import {
  activeTab,
  pathOfItem,
  useWorkspaceStore,
  type ItemRef,
  type Workspace,
} from "../../features/workspace/index.ts";
import { reportClientIssue } from "../../lib/report.ts";

export type Navigate = ReturnType<typeof useNavigate>;

export const go = (navigate: Navigate, path: string) =>
  void navigate({ to: path }).catch(() => reportClientIssue("command_failed"));

export function goToActive(navigate: Navigate): void {
  const next = activeTab(useWorkspaceStore.getState().ws);
  go(navigate, next ? pathOfItem(next.item) : "/");
}

// Set when the active tab closed: the bar then moves focus to the new active tab (or New tab), once it has rendered.
let focusAfterClose = false;

/** True once after a tab closed; the tab bar reads it to move focus. */
export function takeFocusAfterClose(): boolean {
  const asked = focusAfterClose;
  focusAfterClose = false;
  return asked;
}

export function closeItem(navigate: Navigate, key: string): void {
  const store = useWorkspaceStore.getState();
  const wasActive = store.ws.active === key;
  store.close(key);
  if (!wasActive) return;
  focusAfterClose = true;
  goToActive(navigate);
}

const HOME: ItemRef = { kind: "home" };

/** The tab before the active one (the most recent other item), else the one after, else home; null when home is alone. */
export function otherItem(ws: Workspace): ItemRef | null {
  const index = ws.tabs.findIndex((tab) => tab.key === ws.active);
  const found = (ws.tabs[index - 1] ?? ws.tabs[index + 1])?.item;
  if (found) return found;
  return ws.tabs[index]?.item.kind === "home" ? null : HOME;
}

/** False when there is nothing to do (no active tab, or nothing to split with). */
export function toggleSplit(): boolean {
  const store = useWorkspaceStore.getState();
  const tab = activeTab(store.ws);
  if (!tab) return false;
  if (tab.split) store.unsplit(tab.key);
  else {
    const item = otherItem(store.ws);
    if (!item) return false;
    store.split(tab.key, item);
  }
  return true;
}
