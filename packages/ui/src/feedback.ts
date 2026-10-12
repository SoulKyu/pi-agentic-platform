import { useEffect, useRef, useState } from "react";

export type FeedbackPhase = "idle" | "quiet" | "disabled" | "spinner" | "stage";

const LOCAL_MARKS = [100, 1000, 3000] as const;
const REMOTE_MARKS = [200, 3000] as const;
const PERFORMANCE_CLOCK = { now: () => performance.now() };

/**
 * DESIGN.md §7.3 (Orca STYLEGUIDE UX rule 1). Local: nothing under 100 ms, disabled to 1 s, spinner to 3 s, then a
 * stage label. Remote: disabled at once, spinner after about 200 ms, stage label after 3 s. `elapsedMs` is null when
 * nothing is pending.
 */
export function feedbackPhase(elapsedMs: number | null, remote: boolean): FeedbackPhase {
  if (elapsedMs === null) return "idle";
  if (elapsedMs >= 3000) return "stage";
  if (remote) return elapsedMs >= 200 ? "spinner" : "disabled";
  if (elapsedMs >= 1000) return "spinner";
  return elapsedMs >= 100 ? "disabled" : "quiet";
}

/**
 * The phase of an action that started at `since` (a clock reading taken in the event handler), or idle. No state is
 * set during render or synchronously in the effect: timers at the phase boundaries move a clock reading forward.
 */
export function usePendingFeedback(
  since: number | null,
  { remote = true, clock = PERFORMANCE_CLOCK }: { remote?: boolean; clock?: { now(): number } } = {},
): FeedbackPhase {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const timers = (remote ? REMOTE_MARKS : LOCAL_MARKS).map((mark) =>
      window.setTimeout(
        () => setNow(Math.max(clock.now(), since + mark)),
        Math.max(0, since + mark - clock.now()),
      ),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [since, remote, clock]);
  return feedbackPhase(since === null ? null : Math.max(0, now - since), remote);
}

/**
 * Runs one action at a time (Orca useImmediateMutation's in-flight guard) and exposes when it started, for a
 * Button's `pendingSince`. A second call while one runs is ignored.
 */
export function usePendingAction(clock: { now(): number } = PERFORMANCE_CLOCK): {
  since: number | null;
  run<T>(action: () => Promise<T>): Promise<T | undefined>;
} {
  const [since, setSince] = useState<number | null>(null);
  const inFlight = useRef(false);
  const run = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setSince(clock.now());
    try {
      return await action();
    } finally {
      inFlight.current = false;
      setSince(null);
    }
  };
  return { since, run };
}
