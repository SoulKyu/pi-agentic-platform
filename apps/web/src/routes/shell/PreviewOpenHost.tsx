import { useEffect } from "react";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { openPreview } from "./preview-tab.ts";

/** Takes the shell's side of "OPEN PREVIEW" clicked on a page (PF-4): features ask through the store and never import the workspace. */
export function PreviewOpenHost() {
  const requested = usePreviewsStore((state) => state.requested);
  useEffect(() => {
    if (requested === null) return;
    usePreviewsStore.getState().clearRequest();
    openPreview({ kind: "preview", ...requested });
  }, [requested]);
  return null;
}
