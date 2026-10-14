import type { TrustStatus } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { trustFailureText } from "./trust.vm.ts";

/** `trust.status` for the folder, read when the dialog opens and again on `retry`; an answer after unmount is dropped. */
export function useTrustStatus(cwd: string) {
  const [status, setStatus] = useState<TrustStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("trust.status", { cwd })
      .then(
        (answer) => {
          if (current) setStatus(answer);
        },
        (failure: unknown) => {
          if (current) setError(trustFailureText(failure));
        },
      );
    return () => {
      current = false;
    };
  }, [cwd, loads]);
  const retry = useCallback(() => {
    setError(null);
    setLoads((count) => count + 1);
  }, []);
  return { status, error, retry };
}
