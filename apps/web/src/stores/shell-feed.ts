import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useShellStore } from "./shell-store.ts";

/** The one listener of the `shell` stream while the shell is mounted. Its key is local: the stream is the caller's. */
export function feedShell(
  subscriptions: Runtime["subscriptions"],
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe(
    "shell",
    "me",
    (event) => useShellStore.getState().apply(event),
    (code) => {
      // Refused (`capacity`, `internal`…): the tree shows it with a Retry (M4R138).
      useShellStore.getState().fail(code);
      onError?.(code);
    },
  );
}
