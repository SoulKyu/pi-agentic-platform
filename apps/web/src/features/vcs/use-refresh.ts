import type { SessionStatus } from "@pap/contracts";
import { useEffect, useRef } from "react";
import { useShellStore } from "../../stores/shell-store.ts";
import { inRoot } from "./changes.vm.ts";

/** Window focus asks for a refresh at most this often. */
export const FOCUS_REFRESH_MS = 1000;

function statusesUnder(root: string): Map<string, SessionStatus> {
  const found = new Map<string, SessionStatus>();
  for (const session of useShellStore.getState().view.sessions.values())
    if (inRoot(root, session.cwd)) found.set(session.id, session.status);
  return found;
}

/**
 * Asks `refresh` again on window focus (at most once a second) and each time a session whose folder is under `root`
 * goes from running to idle: the agent just finished a turn, so the folder has probably changed.
 */
export function useRefreshTriggers(root: string, refresh: () => void, now: () => number): void {
  const ask = useRef(refresh);
  const clock = useRef(now);
  useEffect(() => {
    ask.current = refresh;
    clock.current = now;
  });

  useEffect(() => {
    let last = Number.NEGATIVE_INFINITY;
    const onFocus = () => {
      const at = clock.current();
      if (at - last < FOCUS_REFRESH_MS) return;
      last = at;
      ask.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    let before = statusesUnder(root);
    return useShellStore.subscribe(() => {
      const after = statusesUnder(root);
      const finished = [...after].some(([id, status]) => before.get(id) === "running" && status === "idle");
      before = after;
      if (finished) ask.current();
    });
  }, [root]);
}
