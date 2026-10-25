import type { Runtime } from "../runtime/index.ts";
import { useLaunchStore } from "./launch-store.ts";

/**
 * The listener of the `launches` stream while the shell is mounted. Its key is local: the stream is the caller's own.
 * A refusal (`not_found` from a daemon without the stream, `capacity`) leaves the store empty: a launch is progress, never required.
 */
export function feedLaunches(subscriptions: Runtime["subscriptions"]): () => void {
  return subscriptions.subscribe(
    "launches",
    "me",
    (event) => useLaunchStore.getState().apply(event),
    () => {},
  );
}
