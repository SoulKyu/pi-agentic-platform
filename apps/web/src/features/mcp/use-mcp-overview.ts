import type { McpOverview } from "@pap/contracts";
import { useCallback, useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import { mcpFailureText } from "./mcp.vm.ts";

/**
 * `mcp.overview` for the folder, read again on `reload`. A later answer replaces an earlier one, an answer for an
 * unmounted screen is dropped, and the last good overview stays on screen while the next one loads or fails.
 */
export function useMcpOverview(cwd: string | undefined) {
  const [value, setValue] = useState<McpOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("mcp.overview", cwd === undefined ? {} : { cwd })
      .then(
        (answer) => {
          if (!current) return;
          setValue(answer);
          setError(null);
        },
        (failure: unknown) => {
          if (current) setError(mcpFailureText(failure, "overview"));
        },
      );
    return () => {
      current = false;
    };
  }, [loads, cwd]);
  const reload = useCallback(() => setLoads((count) => count + 1), []);
  return { value, error, reload };
}
