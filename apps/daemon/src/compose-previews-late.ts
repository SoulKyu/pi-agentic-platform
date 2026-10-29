import type { BoxWiring } from "./compose-boxes-wiring.ts";
import type { AgentsVm } from "./compose-agents-vm-types.ts";
import type { PreviewsLate } from "./compose-previews.ts";
import type { M11 } from "./compose-m11-types.ts";
import { createBoxTunnels } from "./modules/agent-vm/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";

/**
 * The service side of previews, from the modules that exist once the sessions and the VM stack do: the box ops of the project
 * boxes and of the agents' VMs, their tunnels, the platform port, the sessions' own facts and the owners of the boxes. Read from
 * the daemon's records, never from a worker (UX2-R28).
 */
export function previewsLate(modules: {
  readonly vm: Pick<AgentsVm, "runtime" | "redact" | "hostsOf">;
  readonly boxes: Pick<BoxWiring, "workspace">;
  readonly sessions: Pick<SessionsModule, "projectBoxOf" | "shellNetwork" | "modeOf" | "entryText">;
  readonly m11: Pick<M11, "platform" | "agents">;
}): PreviewsLate {
  const { vm, boxes, sessions, m11 } = modules;
  return {
    entryText: sessions.entryText,
    service: {
      runtime: vm.runtime,
      ops: { project: boxes.workspace.boxOps(), agent: boxes.workspace.agentOps() },
      tunnels: createBoxTunnels(vm.runtime),
      platform: m11.platform,
      sessions,
      owners: {
        project: (projectId) => boxes.workspace.boxes().box(projectId)?.ownerId ?? null,
        agent: (agentId) => m11.agents.ownerOf(agentId),
      },
      redact: vm.redact,
      hostsOf: vm.hostsOf,
      notePreview: (projectId, decl, invalid) =>
        boxes.workspace.boxControl().notePreview(projectId, decl, invalid),
    },
  };
}
