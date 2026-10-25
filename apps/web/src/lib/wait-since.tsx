import { LoadingLine } from "@pap/ui";
import { createContext, useContext, useEffect, useState, type MutableRefObject } from "react";

/** One wait of a lazy section: when it began, and whether its data line has already shown (and gone). */
export interface Wait {
  readonly since: number;
  readonly spent: MutableRefObject<boolean>;
}

const now = (): number => performance.now();

const WaitContext = createContext<Wait | undefined>(undefined);

/** A route that lazy-loads a section wraps the boundary in it: the chunk fallback and the section's first data line then count one wait. */
export const WaitSinceProvider = WaitContext.Provider;

/** A new wait at the host's first render and again at each `resetKey` (a chunk retry). */
export function useWaitStart(resetKey = 0): Wait {
  const [wait, setWait] = useState(() => ({
    key: resetKey,
    since: now(),
    spent: { current: false },
  }));
  if (wait.key === resetKey) return wait;
  const next = { key: resetKey, since: now(), spent: { current: false } };
  setWait(next);
  return next;
}

/**
 * The section's data line. The first one continues the chunk's wait; once it has gone (data or failure), a later wait
 * (a retry, another folder) starts its own clock.
 */
export function WaitLine({ label, cause }: { readonly label: string; readonly cause?: string | undefined }) {
  const wait = useContext(WaitContext);
  const [since] = useState(() => (wait === undefined || wait.spent.current ? undefined : wait.since));
  useEffect(
    () => () => {
      if (wait !== undefined) wait.spent.current = true;
    },
    [wait],
  );
  return (
    <LoadingLine
      label={label}
      {...(since === undefined ? {} : { since })}
      {...(cause === undefined ? {} : { cause })}
    />
  );
}
