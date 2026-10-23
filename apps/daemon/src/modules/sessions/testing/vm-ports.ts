import { layoutOf } from "../../agent-vm/index.ts";
import type { SessionsModule } from "../index.ts";

type AgentPorts = Parameters<SessionsModule["setAgentPorts"]>[0];

/**
 * Agents run in microVMs only: a service bed's agent ports get the VM predicates unless the test names its own (`vmLayoutOf:
 * () => null` is a machine with no VM stack). The layout is the process backend's, under the bed's `$PAP_HOME`.
 */
export function withVmPorts(papHome: string, ports: AgentPorts): AgentPorts {
  const { agents } = ports;
  if (!agents || "vmLayoutOf" in agents) return ports;
  const filled = {
    ...agents,
    vmLayoutOf: (row: { id: string; agentId?: string | undefined; agentRole?: string | undefined }) =>
      row.agentId === undefined
        ? null
        : layoutOf("process", papHome, {
            agentId: row.agentId,
            taskKey: row.agentRole === "task" ? row.id.replaceAll("-", "") : null,
          }),
  };
  return { ...ports, agents: filled };
}
