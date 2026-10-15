import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useUsageStore } from "./usage-store.ts";

/** The listener of the `usage` stream while a session screen is open. Its key is local: the stream is the caller's. */
export function feedUsage(
  subscriptions: Runtime["subscriptions"],
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe(
    "usage",
    "me",
    (event) => useUsageStore.getState().apply(event),
    (code) => {
      useUsageStore.getState().fail(code);
      onError?.(code);
    },
  );
}
