import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useVcsStore } from "./vcs-store.ts";

/** The listener of one root's `vcs` stream while a screen shows it. Returns the unsubscribe. */
export function feedVcs(
  subscriptions: Runtime["subscriptions"],
  root: string,
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe(
    "vcs",
    root,
    (event) => useVcsStore.getState().apply(root, event),
    (code) => onError?.(code),
  );
}
