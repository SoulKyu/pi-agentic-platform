import type { UsageRange, UsageSummary } from "@pap/contracts";
import { useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

/** `usage.summary` for the range. The last good answer stays on screen while the next one loads or fails. */
export function useUsageSummary(range: UsageRange): { summary: UsageSummary | null; failed: boolean } {
  const [state, setState] = useState<{ summary: UsageSummary | null; failed: boolean }>({
    summary: null,
    failed: false,
  });
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("usage.summary", { range })
      .then(
        (summary) => current && setState({ summary, failed: false }),
        () => current && setState((now) => ({ ...now, failed: true })),
      );
    return () => {
      current = false;
    };
  }, [range]);
  return state;
}
