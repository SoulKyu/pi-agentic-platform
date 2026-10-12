import type { ReactNode } from "react";
import type { SettingsSection } from "../../features/workspace/index.ts";
import { AppearancePanel } from "../../features/appearance/AppearancePanel.tsx";
import { ShortcutsEditor } from "../../features/commands/editor/ShortcutsEditor.tsx";
import { AccountSection } from "./AccountSection.tsx";
import { LanguageSection } from "./LanguageSection.tsx";

export const SETTINGS_SECTION_RENDERERS: Record<SettingsSection, () => ReactNode> = {
  appearance: () => <AppearancePanel />,
  shortcuts: () => <ShortcutsEditor />,
  language: () => <LanguageSection />,
  account: () => <AccountSection />,
};
