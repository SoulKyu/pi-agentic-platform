import { EmptyState } from "@pap/ui";
import type { ReactNode } from "react";
import type { SettingsSection } from "../../features/workspace/index.ts";
import { t } from "../../i18n/index.ts";
import { AccountSection } from "./AccountSection.tsx";
import { LanguageSection } from "./LanguageSection.tsx";

const soon = (section: SettingsSection) => (
  <EmptyState title={t(`settings.section.${section}`)} purpose={t("settings.soon")} />
);

/** Tasks 25 (appearance) and 27 (shortcuts) replace their placeholders here. */
export const SETTINGS_SECTION_RENDERERS: Record<SettingsSection, () => ReactNode> = {
  appearance: () => soon("appearance"),
  shortcuts: () => soon("shortcuts"),
  language: () => <LanguageSection />,
  account: () => <AccountSection />,
};
