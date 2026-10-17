import type { Destination } from "../../features/notifications/landing.vm.ts";
import {
  activeTab,
  isAgentId,
  isValidId,
  pathOfItem,
  useWorkspaceStore,
} from "../../features/workspace/index.ts";

/** The page a destination is shown on, or null for an id the router does not take as data (M12R33). */
export function pathOfDestination(destination: Destination): string | null {
  switch (destination.kind) {
    case "session":
      return isValidId(destination.id) ? pathOfItem({ kind: "session", id: destination.id }) : null;
    case "agent":
      return isAgentId(destination.id) ? pathOfItem({ kind: "agent", id: destination.id }) : null;
    case "settings":
      return pathOfItem({ kind: "settings", section: destination.section });
    case "inbox":
      return destination.itemId === null || isValidId(destination.itemId) ? activePath() : null;
  }
}

/** Where the Inbox opens over: the tab the person had, or the home. */
export function activePath(): string {
  const tab = activeTab(useWorkspaceStore.getState().ws);
  return tab ? pathOfItem(tab.item) : "/";
}

/** What the shell gives the landing (`LandingRoutes`): one constant for the shell's own mount and the test bed. */
export const ROUTES = { pathOf: pathOfDestination, inboxPath: activePath };
