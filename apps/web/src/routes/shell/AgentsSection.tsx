import { Button, EmptyState } from "@pap/ui";
import { useNavigate } from "@tanstack/react-router";
import { NoVmState } from "../../features/agents/NoVmState.tsx";
import { AgentAvatar } from "../../features/agents/AgentAvatar.tsx";
import { agentTarget, railName, stateWords } from "../../features/agents/rail.vm.ts";
import { useAppearanceStore } from "../../features/appearance/index.ts";
import { runCommand } from "../../features/commands/index.ts";
import { pathOfItem } from "../../features/workspace/index.ts";
import { useVmStatus } from "../../lib/use-vm-status.ts";
import { registerCatalog, useT } from "../../i18n/index.ts";
import { agentsPhoneEn, agentsPhoneFr } from "../../i18n/catalog/agents-phone.ts";
import { useAgents } from "../../stores/agents-store.ts";
import { go } from "./tab-actions.ts";

registerCatalog({ en: agentsPhoneEn, fr: agentsPhoneFr });

/**
 * The phone's Agents tab (M11R109, board 12): the agents with their state in words, then New agent. With none, the
 * empty state offers to create the first one (M3R103's empty state, now with its action).
 */
export function AgentsSection() {
  const t = useT();
  const navigate = useNavigate();
  const agents = useAgents((view) => view.agents);
  const avatarStyle = useAppearanceStore((state) => state.account.avatarStyle);
  const vm = useVmStatus().status;
  const unusable = vm !== null && !vm.usable;
  const create = unusable ? null : (
    <Button
      variant={agents.length === 0 ? "primary" : "secondary"}
      onClick={() => void runCommand("agents.new")}
    >
      {t("shell.rail.newAgent")}
    </Button>
  );
  const noVm = unusable ? <NoVmState /> : null;
  if (agents.length === 0)
    return (
      <div className="p-s3">
        {noVm ?? (
          <EmptyState
            title={t("agentsPhone.emptyTitle")}
            purpose={t("agentsPhone.emptyPurpose")}
            action={create}
          />
        )}
      </div>
    );
  return (
    <div className="flex flex-col gap-s3 p-s3">
      {noVm}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {agents.map((agent) => {
          const name = railName(agent, t);
          return (
            <li key={agent.id}>
              <button
                type="button"
                aria-label={name}
                onClick={() => go(navigate, pathOfItem(agentTarget(agent)))}
                className="flex min-h-11 w-full items-center gap-s3 p-s2 text-left focus-ring"
              >
                <AgentAvatar agent={agent} avatarStyle={avatarStyle} />
                <span className="min-w-0 flex-1 truncate text-ui text-fg">{agent.name}</span>
                <span className="text-ui text-muted">{stateWords(agent, t)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {create === null ? null : <div>{create}</div>}
    </div>
  );
}
