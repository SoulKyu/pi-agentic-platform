import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useTasksStore } from "./tasks-store.ts";

/** A listener of the `tasks` stream. Its key is local: the stream is the caller's. Listeners share one subscription. */
export function feedTasks(
  subscriptions: Runtime["subscriptions"],
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe(
    "tasks",
    "me",
    (event) => useTasksStore.getState().apply(event),
    (code) => onError?.(code),
  );
}
