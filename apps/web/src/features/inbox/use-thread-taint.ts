import { useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { feedSession } from "../../stores/session-feed.ts";
import { useSessionStore } from "../../stores/session-store.ts";

/**
 * The asking thread's CURRENT taint (W5-R38), or null while it is not known. The dialog listens to the thread's session
 * stream while it is open, so the Inbox needs no tab of the agent. A view the store already holds may be stale (a closed
 * tab keeps its last one, and the thread may have read external content since), so only a snapshot of a LATER generation
 * than the one held at mount counts. A snapshot that could not be read keeps the old policy, so it counts for nothing (I1). Without a connection none arrives and the answer stays null: fail closed (C1).
 */
export function useThreadTaint(sessionId: string | null): boolean | null {
  const [held, setHeld] = useState(() => heldGeneration(sessionId));
  if (held.id !== sessionId) setHeld(heldGeneration(sessionId));
  useEffect(() => {
    if (sessionId === null) return;
    const { subscriptions } = getRuntime();
    const stop = feedSession(subscriptions, sessionId);
    if (useSessionStore.getState().views[sessionId]?.loaded) subscriptions.resync("session", sessionId);
    return stop;
  }, [sessionId]);
  return useSessionStore((state) => {
    const view = sessionId === null ? undefined : state.views[sessionId];
    return view?.loaded === true && !view.unreadable && view.generation > held.generation
      ? view.policy.tainted
      : null;
  });
}

const heldGeneration = (id: string | null) => ({
  id,
  generation: id === null ? 0 : (useSessionStore.getState().views[id]?.generation ?? 0),
});
