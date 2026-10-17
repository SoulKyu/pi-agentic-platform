import { AgentView } from "@pap/contracts";
import { useEffect, useRef, useState } from "react";
import { getRuntime, RpcError } from "../../runtime/index.ts";

export type AgentLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly agent: AgentView }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

/**
 * One agent in full (`agents.get`): read when it opens and whenever `stamp` (the stream's last word on it) moves. A
 * newer read replaces an older one that is still in flight. `reload` reads now and says what it found; `set` takes
 * the answer of a save.
 */
export function useAgentView(agentId: string, stamp: string) {
  const [load, setLoad] = useState<AgentLoad>({ kind: "loading" });
  const latest = useRef(0);
  const read = async (): Promise<AgentView | null> => {
    latest.current += 1;
    const mine = latest.current;
    let next: AgentLoad;
    try {
      next = {
        kind: "ready",
        agent: AgentView.parse(await getRuntime().rpc.call("agents.get", { agentId })),
      };
    } catch (failure) {
      next = { kind: failure instanceof RpcError && failure.code === "not_found" ? "gone" : "failed" };
    }
    if (mine === latest.current) setLoad(next);
    return next.kind === "ready" ? next.agent : null;
  };
  useEffect(() => {
    void read();
    return () => {
      latest.current += 1;
    };
    // `read` is rebuilt on every render; the id and the stream's stamp are what decide a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [agentId, stamp]);
  const set = (agent: AgentView) => {
    latest.current += 1;
    setLoad({ kind: "ready", agent });
  };
  return { load, reload: read, set };
}
