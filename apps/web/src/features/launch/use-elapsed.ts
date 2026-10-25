import { useEffect, useState } from "react";

/**
 * The clock of a live step: `Date.now()` repainted once a second while `active`, and not at all after (ADR 0087, the one
 * continuous repaint). The number counts under reduced motion too: only the ring stops, in CSS.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
