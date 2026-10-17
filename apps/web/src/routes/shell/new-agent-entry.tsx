import type { AgentView, ToolPreset } from "@pap/contracts";
import { NewAgentDialog } from "../../features/agents/NewAgentDialog.tsx";
import { SandboxReadFailed } from "../../features/agents/SandboxReadFailed.tsx";
import { useSandboxStatus } from "../../features/agents/use-sandbox-status.ts";
import PresetPicker from "../../features/sessions/PresetPicker.tsx";

export interface NewAgentEntryProps {
  onClose(): void;
  onCreated(agent: AgentView): void;
}

const presetField = (value: ToolPreset, onChange: (preset: ToolPreset) => void) => (
  <PresetPicker value={value} onChange={onChange} />
);

/**
 * The New agent dialog with what only the shell can give it: the sandbox probe (one read, `use-sandbox-status`, made
 * while the dialog is open; a failed read says so and offers "Check again") and M7's tool preset picker. Its own chunk; the shell mounts it only while open.
 */
export function NewAgentEntry({ onClose, onCreated }: NewAgentEntryProps) {
  const sandbox = useSandboxStatus();
  if (sandbox.readFailed && sandbox.status.checkedAt === 0)
    return <SandboxReadFailed sandbox={sandbox} onClose={onClose} />;
  return (
    <NewAgentDialog
      probe={sandbox.status}
      presetField={presetField}
      onClose={onClose}
      onCreated={onCreated}
    />
  );
}
