import type { Runtime } from "../runtime/index.ts";
import { usePreviewsStore } from "./previews-store.ts";

/**
 * The listener of the `previews` stream while the shell (or a preview window) is mounted. Its key is local: the stream is
 * the caller's own. A refusal (`not_found` from a daemon without the stream, `capacity`) leaves the store empty and not
 * ready: the strip stays hidden and a pane never reads a missing service as gone.
 */
export function feedPreviews(subscriptions: Runtime["subscriptions"], onError?: () => void): () => void {
  return subscriptions.subscribe(
    "previews",
    "me",
    (event) => usePreviewsStore.getState().apply(event),
    () => onError?.(),
  );
}
