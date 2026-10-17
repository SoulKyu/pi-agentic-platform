import { DEFAULT_POLICY_SETTINGS } from "@pap/contracts";
import { useEffect, useState } from "react";
import { reportClientIssue } from "../../lib/report.ts";
import { getRuntime } from "../../runtime/index.ts";

/**
 * The owner's own host list (`policy.getSettings`), which `widensReach` judges an agent's list against (W5-R36). Undefined
 * until the read settles, and when it fails: every listed host then counts as reaching beyond, the cautious reading.
 */
export function useOwnerHosts(): readonly string[] | null | undefined {
  const [hosts, setHosts] = useState<readonly string[] | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("policy.getSettings", {})
      .then(
        (answer) => {
          if (live) setHosts((answer.value ?? DEFAULT_POLICY_SETTINGS).allowHosts);
        },
        () => reportClientIssue("setting_load_failed"),
      );
    return () => {
      live = false;
    };
  }, []);
  return hosts;
}
