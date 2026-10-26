import { useCallback, useEffect, useRef, useState } from "react";

export interface Notice {
  readonly tone: "error" | "status";
  readonly text: string;
}

const NONE: ReadonlyMap<string, boolean> = new Map();

const without = (asked: ReadonlyMap<string, boolean>, key: string) =>
  new Map([...asked].filter(([one]) => one !== key));

/**
 * Settings writes, one per key (a switch, a star): a key already in flight sends nothing again, and the control
 * for it reads `pending` (Task 10 carry). Different keys go in parallel; the server queues them and answers
 * `capacity` past its bound, which is shown as it is and never sent again from here. The list is read again once
 * the last write is over, whatever its outcome (a timeout included): the list is the truth, never the call.
 *
 * Pi answers the write and then that read, each in seconds, so a switch shows what was asked (`asked`, by key, the
 * last asked last) from the click until `settled` says the screen's lists read after the last write are in. A failed
 * write drops its key at once: the switch goes back to the list.
 */
export function useModelWrites(
  reload: () => void,
  failureText: (failure: unknown) => string,
  settled: boolean,
) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState(NONE);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    if (settled && inFlight.current.size === 0) setAsked(NONE);
  }, [settled]);

  const run = useCallback(
    async (key: string, job: () => Promise<string | null>, on?: boolean) => {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setPending(new Set(inFlight.current));
      if (on !== undefined) setAsked((now) => without(now, key).set(key, on));
      setNotice(null);
      try {
        const done = await job();
        if (done !== null) setNotice({ tone: "status", text: done });
      } catch (failure) {
        setAsked((now) => without(now, key));
        setNotice({ tone: "error", text: failureText(failure) });
      } finally {
        inFlight.current.delete(key);
        setPending(new Set(inFlight.current));
        if (inFlight.current.size === 0) reload();
      }
    },
    [reload, failureText],
  );
  return { pending, asked, notice, run, say: setNotice };
}
