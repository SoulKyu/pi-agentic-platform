import { useCallback, useRef, useState } from "react";
import { mcpFailureText, type McpAction } from "./mcp.vm.ts";

export interface Notice {
  readonly tone: "error" | "status";
  readonly text: string;
}

/**
 * One write at a time for the whole panel (M7R100): switches, Remove, Undo, Test and code mode wait while one is on
 * its way, and `busy` says so. The overview is read again after every write, whatever its outcome: the list is the
 * truth, never the call (a timeout may have landed, R105).
 */
export function useMcpWrites(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    async (action: McpAction, job: () => Promise<Notice | null>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setNotice(null);
      try {
        setNotice(await job());
      } catch (failure) {
        setNotice({ tone: "error", text: mcpFailureText(failure, action) });
      } finally {
        inFlight.current = false;
        setBusy(false);
        reload();
      }
    },
    [reload],
  );
  return { busy, notice, run, say: setNotice };
}
