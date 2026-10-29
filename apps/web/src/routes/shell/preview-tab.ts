import { itemKey, useWorkspaceStore, type ItemRef } from "../../features/workspace/index.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { SPLIT_PANE_ID } from "./surface.ts";
import { useSurfaceView } from "./surface-view.ts";

export type PreviewItem = Extract<ItemRef, { kind: "preview" }>;

/** The key a preview item arms: `<box key>/<name>`, the same spelling as the stream's services. */
export const armedKey = (item: PreviewItem): string => `${item.box}/${item.name}`;

/**
 * The owner's own click opens a preview (UX2-R41, R77): the active session tab is split with it (focused when it already
 * is the split), any other active tab leaves it a tab of its own. The pane is armed, so it mints its lease when it mounts.
 */
export function openPreview(item: PreviewItem): void {
  usePreviewsStore.getState().arm(armedKey(item));
  const store = useWorkspaceStore.getState();
  const tab = store.ws.tabs.find((one) => one.key === store.ws.active);
  if (!tab || tab.item.kind !== "session") {
    store.open(item);
    return;
  }
  if (tab.split && itemKey(tab.split.item) === itemKey(item)) document.getElementById(SPLIT_PANE_ID)?.focus();
  else store.split(tab.key, item);
  useSurfaceView.getState().show(tab.key, "preview");
}
