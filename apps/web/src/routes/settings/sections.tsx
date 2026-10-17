import type { ReactNode } from "react";
import type { SettingsSection } from "../../features/workspace/index.ts";
import { AppearancePanel } from "../../features/appearance/AppearancePanel.tsx";
import { ShortcutsEditor } from "../../features/commands/editor/ShortcutsEditor.tsx";
import { AccountSection } from "./AccountSection.tsx";
import { AgentsSettings } from "./AgentsSettings.tsx";
import { ApprovalsSection } from "./ApprovalsSection.tsx";
import { LanguageSection } from "./LanguageSection.tsx";
import { MemorySettings } from "./MemorySettings.tsx";
import { McpSettings } from "./McpSettings.tsx";
import { ModelsSettings } from "./ModelsSettings.tsx";
import { AutomationSettings } from "./AutomationSettings.tsx";
import { NotificationsSettings } from "./NotificationsSettings.tsx";
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
  agents: () => <AgentsSettings />,
  memory: () => <MemorySettings />,
  notifications: () => <NotificationsSettings />,
  account: () => <AccountSection />,
};
