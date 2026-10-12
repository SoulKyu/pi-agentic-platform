import { useCallback, useEffect, useRef, useState } from "react";
import { failureText } from "./failure.ts";

/** Nothing shows under 100 ms and a label after one second (spec C §7.4): the text of a slow action changes at this age. */
export const SLOW_MS = 1000;

/** Lets the screen know an action is in flight (see `useStructural`). */
export type Track = <T>(call: Promise<T>) => Promise<T>;

/**
 * Calls that change the session's tree or its file (navigate, compact, fork...) are not part of the view: the daemon
 * answers `session_busy` to anything that comes meanwhile, and "stop it first" must stay possible. The screen counts
 * them here, so the composer can keep Stop and the other actions can wait.
 */
export function useStructural(): { readonly track: Track; readonly active: boolean } {
  const [count, setCount] = useState(0);
  const track = useCallback<Track>((call) => {
    setCount((n) => n + 1);
    return call.finally(() => setCount((n) => n - 1));
  }, []);
  return { track, active: count > 0 };
}

/**
 * One action button's state: disabled from the click to the answer, `slow` once the answer takes a second, and a
 * failure reported through `report` with the i18n text of its code only. A mutation is never repeated here: after a
 * `timeout` its outcome is unknown, and the text of that code says so (R105).
 */
export function useAction(track: Track, report: (message: string | null) => void) {
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [busy]);
  const run = async (call: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    report(null);
    try {
      await track(call());
      return true;
    } catch (failure) {
      report(failureText(failure));
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, slow, run };
}
