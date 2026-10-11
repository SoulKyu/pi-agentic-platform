import { EmptyState } from "@pap/ui";
import type { ReactNode } from "react";
import type { SettingsSection } from "../../features/workspace/index.ts";
import { AppearancePanel } from "../../features/appearance/AppearancePanel.tsx";
import { t } from "../../i18n/index.ts";
import { AccountSection } from "./AccountSection.tsx";
import { LanguageSection } from "./LanguageSection.tsx";

const soon = (section: SettingsSection) => (
  <EmptyState title={t(`settings.section.${section}`)} purpose={t("settings.soon")} />
);

/** Task 27 (shortcuts) replaces its placeholder here. */
export const SETTINGS_SECTION_RENDERERS: Record<SettingsSection, () => ReactNode> = {
  appearance: () => <AppearancePanel />,
  shortcuts: () => soon("shortcuts"),
  language: () => <LanguageSection />,
  account: () => <AccountSection />,
};
