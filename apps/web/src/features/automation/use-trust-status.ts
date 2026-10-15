import type { TrustStatus } from "@pap/contracts";
import { useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

/** Pi's trust decision for the folder (`trust.status`, as M7's dialog reads it); null while unknown or when the call is refused. */
export function useTrustStatus(cwd: string): TrustStatus | null {
  const [answer, setAnswer] = useState<{ cwd: string; status: TrustStatus } | null>(null);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("trust.status", { cwd })
      .then(
        (status) => {
          if (current) setAnswer({ cwd, status });
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [cwd]);
  return answer?.cwd === cwd ? answer.status : null;
}
