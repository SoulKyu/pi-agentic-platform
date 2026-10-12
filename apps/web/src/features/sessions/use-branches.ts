import type { ForkPoint } from "@pap/contracts";
import { useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import type { SessionView } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { failureText } from "./failure.ts";

const NONE: readonly ForkPoint[] = [];

/**
 * The fork points of the session, asked for after every snapshot and every settled run (never while the agent works).
 * One request is in flight at a time and a burst of triggers folds into one more. An answer whose `generation` or
 * `leafId` is no longer the view's is dropped (M2R144, M2-RT-12).
 */
export function useBranches(sessionId: string, view: SessionView) {
  const [points, setPoints] = useState<readonly ForkPoint[]>(NONE);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = async (): Promise<void> => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        const asked = useSessionStore.getState().views[sessionId];
        if (!asked || !alive.current) break;
        try {
          const answer = await getRuntime().rpc.call("sessions.branches", { sessionId });
          const now = useSessionStore.getState().views[sessionId];
          if (!alive.current || now?.generation !== asked.generation || now.leafId !== asked.leafId) continue;
          setPoints(answer.points);
          setError(null);
        } catch (failure) {
          if (alive.current) setError(failureText(failure));
        }
      } while (again.current);
    } finally {
      inFlight.current = false;
    }
  };

  const running = view.status === "running" || view.status === "starting";
  useEffect(() => {
    if (view.loaded && !running) void refresh();
    // refresh reads the store and refs only; the triggers are the view's generation, its leaf and the run state.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [sessionId, view.loaded, view.generation, view.leafId, running]);

  return { points, error };
}
