import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useHealthStore } from "./health-store.ts";

/** A listener of the `ops` stream. Its key is local: the stream is daemon-wide, keyed per owner server-side. */
export function feedOps(
  subscriptions: Runtime["subscriptions"],
  onError?: (code: RpcErrorCode) => void,
): () => void {
  return subscriptions.subscribe(
    "ops",
    "me",
    (event) => useHealthStore.getState().apply(event),
    (code) => onError?.(code),
  );
}
