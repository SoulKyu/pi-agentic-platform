import "./register-agent-catalog.ts";
import type { AgentView, ToolPreset } from "@pap/contracts";
import { Dialog } from "@pap/ui/overlays";
import type { ReactNode } from "react";
import { useT } from "../../i18n/index.ts";
import { useVmStatus } from "../../lib/use-vm-status.ts";
import { NoVmState } from "./NoVmState.tsx";
import { AgentForm } from "./AgentForm.tsx";
import { useNewAgentDefaults } from "./use-new-agent-defaults.ts";

interface Props {
  presetField(value: ToolPreset, onChange: (preset: ToolPreset) => void): ReactNode;
  onClose(): void;
  /** The new agent: the caller opens its tab (M11R96). */
  onCreated(agent: AgentView): void;
}

/**
 * "New agent" (M11R96): the agent form in a dialog, mounted only while open, starting from the sandbox of the agents
 * settings (M11R99). Reached from the rail, home, Settings and ⌘K.
 */
export function NewAgentDialog({ presetField, onClose, onCreated }: Props) {
  const t = useT();
  const { start, late } = useNewAgentDefaults();
  const vm = useVmStatus().status;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("agentForm.dialog.title")}
      description={t("agentForm.dialog.description")}
      closeLabel={t("agentForm.dialog.close")}
    >
      {vm !== null && !vm.usable ? (
        <NoVmState />
      ) : start === null ? (
        // the form reads its starting values once, so it waits for them
        <p role="status" className="text-ui text-muted">
          {t("agentForm.dialog.loading")}
        </p>
      ) : (
        <>
          {late ? (
            <p role="status" className="p-s3 text-ui text-attn">
              {t("agentForm.dialog.late")}
            </p>
          ) : null}
          <AgentForm
            agent={null}
            start={start}
            presetField={presetField}
            onCancel={onClose}
            onSaved={(agent) => {
              onCreated(agent);
              onClose();
            }}
          />
        </>
      )}
    </Dialog>
  );
}
