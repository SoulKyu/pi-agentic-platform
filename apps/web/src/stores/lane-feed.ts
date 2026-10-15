import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useLaneStore } from "./lane-store.ts";

/** Retry: asks for the lane stream again; a snapshot clears the error. */
export const retryLanes = (subscriptions: Runtime["subscriptions"]): void =>
  subscriptions.resync("lane", "me");

/** The one listener of the `lane` stream while the shell is mounted. Its key is local: the stream is the caller's. */
export function feedLanes(
  subscriptions: Runtime["subscriptions"],
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe(
    "lane",
    "me",
    (event) => useLaneStore.getState().apply(event),
    (code) => {
      // Refused or failed: the tab and the tree show it with a Retry.
      useLaneStore.getState().fail(code);
      onError?.(code);
    },
  );
}
