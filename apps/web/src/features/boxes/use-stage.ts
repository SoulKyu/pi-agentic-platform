import { useEffect, useState } from "react";

export type StartFeedback = "quiet" | "spinner" | "stage";

/**
 * §7.3 for a wait the daemon reports (the box is `starting`): nothing for 1 s, then the spinner, and after 3 s the stage
 * label. No state is set in the effect body: the timers move it, and the cleanup puts it back.
 */
export function useStartFeedback(active: boolean): StartFeedback {
  const [reached, setReached] = useState<StartFeedback>("quiet");
  useEffect(() => {
    if (!active) return undefined;
    const spinner = window.setTimeout(() => setReached("spinner"), 1000);
    const stage = window.setTimeout(() => setReached("stage"), 3000);
    return () => {
      window.clearTimeout(spinner);
      window.clearTimeout(stage);
      setReached("quiet");
    };
  }, [active]);
  return active ? reached : "quiet";
}
