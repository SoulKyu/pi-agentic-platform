import { itemKey, useWorkspaceStore } from "../../features/workspace/index.ts";

/** A new trigger was saved: its own tab opens and the empty `new:<project>` tab goes away, so a reload shows the saved trigger. */
export function openTriggerInstead(newId: string, createdId: string): void {
  const store = useWorkspaceStore.getState();
  store.open({ kind: "trigger", id: createdId });
  store.close(itemKey({ kind: "trigger", id: newId }));
}
