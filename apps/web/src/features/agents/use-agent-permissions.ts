import { PermissionsView } from "@pap/contracts";
import { useEffect, useRef, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";

export type PermissionsLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: PermissionsView }
  | { readonly kind: "failed" };

/**
 * One agent's permissions (`agents.permissions`): read when the tab opens and whenever `stamp` (the stream's last word on
 * the agent) moves, so a saved form shows its new reach. A newer read replaces an older one still in flight. The call never
 * starts a worker.
 */
export function useAgentPermissions(agentId: string, stamp: string): PermissionsLoad {
  const [load, setLoad] = useState<PermissionsLoad>({ kind: "loading" });
  const latest = useRef(0);
  useEffect(() => {
    latest.current += 1;
    const mine = latest.current;
    getRuntime()
      .rpc.call("agents.permissions", { agentId })
      .then(
        (answer) => {
          if (mine !== latest.current) return;
          const parsed = PermissionsView.safeParse(answer);
          setLoad(parsed.success ? { kind: "ready", view: parsed.data } : { kind: "failed" });
        },
        () => {
          if (mine === latest.current) setLoad({ kind: "failed" });
        },
      );
    return () => {
      latest.current += 1;
    };
  }, [agentId, stamp]);
  return load;
}
