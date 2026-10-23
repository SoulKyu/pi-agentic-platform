import type { AgentView, ToolPreset } from "@pap/contracts";
import { NewAgentDialog } from "../../features/agents/NewAgentDialog.tsx";
import PresetPicker from "../../features/sessions/PresetPicker.tsx";

export interface NewAgentEntryProps {
  onClose(): void;
  onCreated(agent: AgentView): void;
}

const presetField = (value: ToolPreset, onChange: (preset: ToolPreset) => void) => (
  <PresetPicker value={value} onChange={onChange} />
);

/** The New agent dialog with what only the shell can give it: M7's tool preset picker. Its own chunk; the shell mounts it only while open. */
export function NewAgentEntry({ onClose, onCreated }: NewAgentEntryProps) {
  return <NewAgentDialog presetField={presetField} onClose={onClose} onCreated={onCreated} />;
}
