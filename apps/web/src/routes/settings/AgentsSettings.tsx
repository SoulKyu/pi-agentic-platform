import { useEffect, useRef, useState } from "react";
import { AgentSettingsView } from "../../features/agents/AgentSettingsView.tsx";
import { AgentsList } from "../../features/agents/AgentsList.tsx";
import { NewAgentDialog } from "../../features/agents/NewAgentDialog.tsx";
import { SandboxStatus } from "../../features/agents/SandboxStatus.tsx";
import { SubagentsSettings } from "../../features/agents/SubagentsSettings.tsx";
import { VmStatus } from "../../features/agents/VmStatus.tsx";
import { useSandboxStatus } from "../../features/agents/use-sandbox-status.ts";
import { useAppearanceStore } from "../../features/appearance/appearance-store.ts";
import { ClaudeToken } from "../../features/settings/ClaudeToken.tsx";
import PresetPicker from "../../features/sessions/PresetPicker.tsx";
import { useT } from "../../i18n/index.ts";
import { useVmStatus } from "../../lib/use-vm-status.ts";
import { useAgents } from "../../stores/agents-store.ts";

/**
 * Settings › Agents (M11R97): the owner's agents from the `agents` stream's store, the sandbox with its re-check, and one
 * agent's settings (the agent form of Task 15). The sandbox is read once here and handed to the dialog and the form.
 */
export function AgentsSettings() {
  const t = useT();
  const sandbox = useSandboxStatus();
  const { status: vm, reload } = useVmStatus();
  const view = useAgents((agents) => agents);
  const avatarStyle = useAppearanceStore((state) => state.account.avatarStyle);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Back to the list: focus goes to its heading. The agent view focuses its own heading once loaded.
  const root = useRef<HTMLDivElement>(null);
  const shown = useRef(openId);
  useEffect(() => {
    if (shown.current === openId) return;
    shown.current = openId;
    if (openId === null) root.current?.querySelector<HTMLElement>("#agents-list-title")?.focus();
  }, [openId]);
  const presetField = (
    value: Parameters<typeof PresetPicker>[0]["value"],
    onChange: (preset: typeof value) => void,
  ) => <PresetPicker value={value} onChange={onChange} />;
  return (
    <div ref={root} className="flex flex-col gap-s6">
      <p className="text-ui text-muted">{t("settings.agents.intro")}</p>
      {openId === null ? (
        <>
          <AgentsList
            view={view}
            avatarStyle={avatarStyle}
            onOpen={setOpenId}
            onNew={() => setCreating(true)}
          />
          {vm?.runtime === "vm" ? (
            <>
              <VmStatus status={vm} reload={reload} />
              <ClaudeToken state={vm.claudeToken} onChanged={reload} />
            </>
          ) : (
            <SandboxStatus sandbox={sandbox} />
          )}
          <SubagentsSettings />
        </>
      ) : (
        <AgentSettingsView
          agentId={openId}
          summary={view.agents.find((agent) => agent.id === openId)}
          probe={sandbox.status}
          presetField={presetField}
          onBack={() => setOpenId(null)}
        />
      )}
      {creating ? (
        <NewAgentDialog
          probe={sandbox.status}
          presetField={presetField}
          onClose={() => setCreating(false)}
          onCreated={(agent) => setOpenId(agent.id)}
        />
      ) : null}
    </div>
  );
}
