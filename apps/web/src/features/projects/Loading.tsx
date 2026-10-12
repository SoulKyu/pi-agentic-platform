import { Spinner, usePendingFeedback } from "@pap/ui";
import { useState } from "react";

/** Nothing for the first moments of a load, then a labelled spinner (DESIGN.md §7.3). Mounted only while loading. */
export function Loading({ label }: { readonly label: string }) {
  const [since] = useState(() => performance.now());
  const phase = usePendingFeedback(since);
  return phase === "spinner" || phase === "stage" ? <Spinner label={label} /> : null;
}
