import type { ToolPreset } from "@pap/contracts";
import { AgentScreen, type AgentScreenProps } from "../../features/agents/AgentScreen.tsx";
import PresetPicker from "../../features/sessions/PresetPicker.tsx";
import { FilesPaneEntry } from "./files-pane-entry.tsx";

export type AgentPaneProps = Omit<AgentScreenProps, "presetField" | "filesPane">;

const presetField = (value: ToolPreset, onChange: (preset: ToolPreset) => void) => (
  <PresetPicker value={value} onChange={onChange} />
);

const filesPane = (root: string) => <FilesPaneEntry root={root} />;

/**
 * The agent tab with M7's tool preset picker for its Settings tab and the files pane for its Files tab: features never import each other, so the shell joins
 * them. Loaded lazily with the tab, which keeps the picker out of the initial bundle.
 */
export function AgentPaneEntry(props: AgentPaneProps) {
  return <AgentScreen {...props} presetField={presetField} filesPane={filesPane} />;
}
