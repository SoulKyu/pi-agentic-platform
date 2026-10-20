import { VmStatusView } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../runtime/index.ts";

export interface VmStatusControl {
  /** Null until the first answer, and after one that cannot be read: the page then behaves as in host mode. */
  readonly status: VmStatusView | null;
  /** Reads `agents.vmStatus` again. */
  reload(): void;
}

/**
 * `agents.vmStatus`, read when the component mounts and on `reload`. An answer that fails or has the wrong shape leaves
 * the status null, so a daemon without VMs (or a stub) never changes a screen. An answer for an unmounted screen is dropped.
 */
export function useVmStatus(): VmStatusControl {
  const [status, setStatus] = useState<VmStatusView | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("agents.vmStatus", {})
      .then(
        (answer) => {
          const parsed = VmStatusView.safeParse(answer);
          if (live) setStatus(parsed.success ? parsed.data : null);
        },
        () => {
          if (live) setStatus(null);
        },
      );
    return () => {
      live = false;
    };
  }, [reads]);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  return { status, reload };
}
