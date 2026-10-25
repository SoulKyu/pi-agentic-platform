import { useEffect, useState, type ReactNode } from "react";

/** DESIGN.md §7.3: nothing under 100 ms. A loading line shows only when the wait is long enough to notice. */
export function DeferredFallback({
  delayMs,
  children,
}: {
  readonly delayMs?: number;
  readonly children: ReactNode;
}) {
  const [late, setLate] = useState(false);
  const delay = delayMs ?? 100;
  useEffect(() => {
    const timer = setTimeout(() => {
      setLate(true);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [delay]);
  return late ? <>{children}</> : null;
}
