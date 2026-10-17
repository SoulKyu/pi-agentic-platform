import type { ToolPreset } from "@pap/contracts";
import { AgentScreen, type AgentScreenProps } from "../../features/agents/AgentScreen.tsx";
import PresetPicker from "../../features/sessions/PresetPicker.tsx";

export type AgentPaneProps = Omit<AgentScreenProps, "presetField">;

const presetField = (value: ToolPreset, onChange: (preset: ToolPreset) => void) => (
  <PresetPicker value={value} onChange={onChange} />
);

/**
 * The agent tab with M7's tool preset picker for its Settings tab: features never import each other, so the shell joins
 * them. Loaded lazily with the tab, which keeps the picker out of the initial bundle.
 */
export function AgentPaneEntry(props: AgentPaneProps) {
  return <AgentScreen {...props} presetField={presetField} />;
}
