import { useCallback, useRef, useState } from "react";

export interface Notice {
  readonly tone: "error" | "status";
  readonly text: string;
}

/**
 * Settings writes, one per key (a switch, a star): a key already in flight sends nothing again, and the control
 * for it reads `pending` (Task 10 carry). Different keys go in parallel; the server queues them and answers
 * `capacity` past its bound, which is shown as it is and never sent again from here. The list is read again once
 * the last write is over, whatever its outcome (a timeout included): the list is the truth, never the call.
 */
export function useModelWrites(reload: () => void, failureText: (failure: unknown) => string) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(new Set<string>());

  const run = useCallback(
    async (key: string, job: () => Promise<string | null>) => {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setPending(new Set(inFlight.current));
      setNotice(null);
      try {
        const done = await job();
        if (done !== null) setNotice({ tone: "status", text: done });
      } catch (failure) {
        setNotice({ tone: "error", text: failureText(failure) });
      } finally {
        inFlight.current.delete(key);
        setPending(new Set(inFlight.current));
        if (inFlight.current.size === 0) reload();
      }
    },
    [reload, failureText],
  );
  return { pending, notice, run, say: setNotice };
}
