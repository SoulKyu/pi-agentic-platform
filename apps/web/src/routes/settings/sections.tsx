import type { ReactNode } from "react";
import type { SettingsSection } from "../../features/workspace/index.ts";
import { AppearancePanel } from "../../features/appearance/AppearancePanel.tsx";
import { ShortcutsEditor } from "../../features/commands/editor/ShortcutsEditor.tsx";
import { AccountSection } from "./AccountSection.tsx";
import { ApprovalsSection } from "./ApprovalsSection.tsx";
import { LanguageSection } from "./LanguageSection.tsx";
import { McpSettings } from "./McpSettings.tsx";
import { ModelsSettings } from "./ModelsSettings.tsx";
import { AutomationSettings } from "./AutomationSettings.tsx";
import { SkillsSettings } from "./SkillsSettings.tsx";

export const SETTINGS_SECTION_RENDERERS: Record<SettingsSection, () => ReactNode> = {
  appearance: () => <AppearancePanel />,
  shortcuts: () => <ShortcutsEditor />,
  language: () => <LanguageSection />,
  approvals: () => <ApprovalsSection />,
  models: () => <ModelsSettings />,
  mcp: () => <McpSettings />,
  skills: () => <SkillsSettings />,
  automation: () => <AutomationSettings />,
  account: () => <AccountSection />,
};
