import { UsageSummary } from "@pap/contracts";
import { useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

/**
 * The owner's spend over 30 days (PH4), asked once when the home mounts: no polling (§8). A failure or an answer this
 * build cannot read leaves it null, and the status line goes on without its spend.
 */
export function useSpend(): UsageSummary | null {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("usage.summary", { range: "30d" })
      .then(
        (answer) => {
          const parsed = UsageSummary.safeParse(answer);
          if (current && parsed.success) setSummary(parsed.data);
        },
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, []);
  return summary;
}
