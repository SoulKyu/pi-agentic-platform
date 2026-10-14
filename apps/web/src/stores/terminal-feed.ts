import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useTerminalStore } from "./terminal-store.ts";

/** The one listener of the `terminal` stream while a screen shows the list. Its key is local: the stream is the caller's. */
export function feedTerminals(
  subscriptions: Runtime["subscriptions"],
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe(
    "terminal",
    "me",
    (event) => useTerminalStore.getState().apply(event),
    (code) => onError?.(code),
  );
}
