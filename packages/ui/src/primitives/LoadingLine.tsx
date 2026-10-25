import { useEffect, useState } from "react";
import { Spinner } from "./Spinner.tsx";

const SHOW_MS = 100;
const ELAPSED_MS = 3000;
const CAUSE_MS = 10_000;
const now = (): number => performance.now();

/** The next moment the line changes: its first appearance, then each second from the elapsed mark. */
function untilNext(elapsed: number): number {
  if (elapsed < SHOW_MS) return SHOW_MS - elapsed;
  if (elapsed < ELAPSED_MS) return ELAPSED_MS - elapsed;
  return 1000 - ((elapsed - ELAPSED_MS) % 1000);
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes} min ${total % 60} s` : `${total} s`;
}

/**
 * DESIGN.md §7.3 for a short wait: nothing under 100 ms, then a spinner and the label (it ends with "…"), the elapsed
 * time from 3 s, the cause from 10 s. `since` is a `performance.now()` reading shared by a chunk fallback and the data
 * line after it, so both count as one wait. `deferred={false}` inside `LazyBoundary`, which already waits 100 ms.
 */
export function LoadingLine({
  label,
  since,
  cause,
  deferred,
}: {
  readonly label: string;
  readonly since?: number;
  readonly cause?: string;
  readonly deferred?: boolean | undefined;
}) {
  const [start] = useState(() => since ?? now());
  const origin = since ?? start;
  const [elapsed, setElapsed] = useState(() => Math.max(0, now() - origin));
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const ms = Math.max(0, now() - origin);
      setElapsed(ms);
      timer = window.setTimeout(tick, untilNext(ms));
    };
    timer = window.setTimeout(tick, untilNext(Math.max(0, now() - origin)));
    return () => window.clearTimeout(timer);
  }, [origin]);
  if (deferred !== false && elapsed < SHOW_MS) return null;
  return (
    <div role="status" data-slot="loading-line" className="flex items-center gap-s2 text-ui text-muted">
      <Spinner />
      <span>{label}</span>
      {elapsed >= ELAPSED_MS ? (
        <span aria-hidden className="tabular-nums">
          {formatElapsed(elapsed)}
        </span>
      ) : null}
      {cause !== undefined && elapsed >= CAUSE_MS ? <span>{cause}</span> : null}
    </div>
  );
}
