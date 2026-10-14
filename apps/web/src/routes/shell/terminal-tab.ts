import { itemKey, useWorkspaceStore, type ItemRef } from "../../features/workspace/index.ts";

type TerminalItem = Extract<ItemRef, { kind: "terminal" }>;

/** Where the terminal is shown: as a tab of its own, or as the split pane of another tab. */
function removeFromWorkspace(item: TerminalItem): void {
  const store = useWorkspaceStore.getState();
  const key = itemKey(item);
  const owner = store.ws.tabs.find(
    (tab) => tab.key !== key && tab.split !== null && itemKey(tab.split.item) === key,
  );
  // The tab that holds the terminal as its split stays; a tab of its own goes.
  if (owner) store.unsplit(owner.key);
  else store.close(key);
}

/** Close: the terminal's pane goes away, as a tab or as a split (MC35). */
export const leaveTerminal = (item: TerminalItem): void => removeFromWorkspace(item);

/** "New terminal here": the new terminal opens as a tab, and the ended one's pane goes away. */
export function openTerminalInstead(item: TerminalItem, id: string): void {
  useWorkspaceStore.getState().open({ kind: "terminal", id });
  removeFromWorkspace(item);
}
