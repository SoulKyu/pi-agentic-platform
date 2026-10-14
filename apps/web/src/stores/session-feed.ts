import type { RpcErrorCode, Runtime } from "../runtime/index.ts";
import { useSessionStore } from "./session-store.ts";

/**
 * The one listener of a session's stream: its events build the session's view in the store. Run it once per
 * session id (listeners of a key share one server stream, and a late one gets no snapshot). `onError` hears a
 * refusal (`not_found`, `capacity`...): show it, and do not subscribe again from there.
 */
export function feedSession(
  subscriptions: Runtime["subscriptions"],
  sessionId: string,
  onError?: (code: RpcErrorCode) => void,
  /** Hears each live event after it is applied (a snapshot included: the listener tells them apart). */
  onEvent?: (event: unknown) => void,
): () => void {
  return subscriptions.subscribe(
    "session",
    sessionId,
    (event) => {
      useSessionStore.getState().apply(sessionId, event);
      onEvent?.(event);
    },
    onError,
  );
}
