import { useCallback, useEffect, useRef, useState } from "react";
import { failureText } from "./step-up.ts";

/**
 * One mutation at a time for a list. Whatever the outcome (a timeout included, R105) `reload` runs after it: the
 * list is the truth, never the call. A failure stays on screen across that reload.
 */
export function useMutation(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    (job: () => Promise<void>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      job()
        .catch((failure: unknown) => {
          if (alive.current) setError(failureText(failure));
        })
        .finally(() => {
          running.current = false;
          if (!alive.current) return;
          setBusy(false);
          reload();
        });
    },
    [reload],
  );
  return { busy, error, run };
}
