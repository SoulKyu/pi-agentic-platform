import { AgentStatus } from "@pap/contracts";
import { useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

/**
 * What the agent spent today, for its header line (board 12): one `agents.status` read when the agent opens and again when
 * `refreshKey` moves (the header's own read rhythm). A failed read leaves the header without the figure; the status panel
 * has its own read and says so when it fails.
 */
export function useCostToday(agentId: string, refreshKey: string): number | null {
  const [read, setRead] = useState<{ readonly agentId: string; readonly usd: number } | null>(null);
  useEffect(() => {
    let current = true;
    getRuntime()
      .rpc.call("agents.status", { agentId })
      .then((raw) => {
        if (current) setRead({ agentId, usd: AgentStatus.parse(raw).today.usd });
      })
      // The header goes without the figure; the status panel reads the same call and reports its own failure.
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [agentId, refreshKey]);
  return read?.agentId === agentId ? read.usd : null;
}
