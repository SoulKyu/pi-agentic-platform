import type { ModelsOverview } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { failureText } from "./failure.ts";

/**
 * `models.overview`, read again on `reload`. A later answer replaces an earlier one, an answer for an unmounted
 * screen is dropped, and the last good overview stays on screen while the next one loads or fails.
 */
export function useOverview() {
  const [value, setValue] = useState<ModelsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("models.overview", {})
      .then(
        (answer) => {
          if (!current) return;
          setValue(answer);
          setError(null);
        },
        (failure: unknown) => {
          if (current) setError(failureText(failure));
        },
      );
    return () => {
      current = false;
    };
  }, [loads]);
  const reload = useCallback(() => setLoads((count) => count + 1), []);
  return { value, error, reload };
}
