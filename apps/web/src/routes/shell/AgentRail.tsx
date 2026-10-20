import type { AgentSummary } from "@pap/contracts";
import { cn, FOCUS_RING, IconButton, IconPlus, Tooltip } from "@pap/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { AgentAvatar } from "../../features/agents/AgentAvatar.tsx";
import { agentTarget, railName } from "../../features/agents/rail.vm.ts";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { runCommand } from "../../features/commands/index.ts";
import { itemFromPath, pathOfItem } from "../../features/workspace/index.ts";
import "../../features/agents/register-vm-catalog.ts";
import { useT } from "../../i18n/index.ts";
import { useVmStatus } from "../../lib/use-vm-status.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { go } from "./tab-actions.ts";

function AgentButton({
  agent,
  current,
  greyed,
}: {
  readonly agent: AgentSummary;
  readonly current: boolean;
  /** The VMs cannot run (spec §12): every agent is greyed out and says why. */
  readonly greyed: boolean;
}) {
  const t = useT();
  const navigate = useNavigate();
  const avatarStyle = useAppearanceStore((state) => state.account.avatarStyle);
  const railRight = useAppearanceStore((state) => state.account.railPosition === "right");
  const name = greyed ? `${railName(agent, t)}. ${t("agentVm.unusable")}` : railName(agent, t);
  return (
    <Tooltip label={name} side={railRight ? "left" : "right"}>
      <button
        type="button"
        aria-label={name}
        aria-current={current ? "page" : undefined}
        aria-disabled={greyed ? true : undefined}
        onClick={() => go(navigate, pathOfItem(agentTarget(agent)))}
        className={cn(
          "rounded-md border p-s1",
          current ? "border-border-strong bg-surface-2" : "border-transparent",
          greyed ? "opacity-50" : null,
          FOCUS_RING,
        )}
      >
        <AgentAvatar agent={agent} avatarStyle={avatarStyle} />
      </button>
    </Tooltip>
  );
}

/**
 * The agents of the rail (board 05 option 2, M11R108): one avatar each in creation order, then "+" (always in view).
 * Past the rail's height the avatars scroll inside it; the "+" stays where it is.
 */
export function AgentRail() {
  const t = useT();
  const agents = useAgents((view) => view.agents);
  const vm = useVmStatus().status;
  const greyed = vm !== null && vm.runtime === "vm" && !vm.usable;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const item = itemFromPath(pathname, false);
  const currentId = item?.kind === "agent" ? item.id : null;
  return (
    <>
      <div
        data-slot="agent-rail"
        className="flex min-h-0 flex-col items-center gap-s2 overflow-y-auto px-s1 py-s1"
      >
        {agents.map((agent) => (
          <AgentButton key={agent.id} agent={agent} current={agent.id === currentId} greyed={greyed} />
        ))}
      </div>
      <IconButton
        icon={IconPlus}
        label={t("shell.rail.newAgent")}
        onClick={() => void runCommand("agents.new")}
      />
    </>
  );
}
