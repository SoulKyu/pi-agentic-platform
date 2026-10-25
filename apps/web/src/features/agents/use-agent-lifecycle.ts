import type { AgentSummary } from "@pap/contracts";
import { useVmStatus } from "../../lib/use-vm-status.ts";
import { useIsLaunching } from "../../stores/launch-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { agentLifecycle, type Lifecycle } from "./agent-lifecycle.ts";

/**
 * The one lifecycle every surface of an agent shows: its summary, its thread's session status and its VM phase
 * (`agents.vmStatus`, read once; null until read or when it cannot be read). Null means ready: no badge.
 */
export function useAgentLifecycle(agent: AgentSummary, sessionId: string | null): Lifecycle | null {
  const session = useSessionStore((state) =>
    sessionId === null ? null : (state.views[sessionId]?.status ?? null),
  );
  const { status } = useVmStatus();
  // A live launch is the VM waking up, said at once; the one-shot status only fills in what no launch says.
  const launching = useIsLaunching({ kind: "agent", id: agent.id });
  const phase = launching
    ? "starting"
    : (status?.agents.find((entry) => entry.id === agent.id)?.phase ?? null);
  return agentLifecycle(agent, session, phase);
}
