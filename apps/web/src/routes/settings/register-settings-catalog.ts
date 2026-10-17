import { registerCatalog } from "../../i18n/index.ts";
import { settingsAccessEn, settingsAccessFr } from "../../i18n/catalog/settings-access.ts";
import { settingsAgentsEn, settingsAgentsFr } from "../../i18n/catalog/settings-agents.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { settingsApprovalsEn, settingsApprovalsFr } from "../../i18n/catalog/settings-approvals.ts";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";
import { settingsShortcutsEn, settingsShortcutsFr } from "../../i18n/catalog/settings-shortcuts.ts";

// Evaluated with the Settings chunk, before any of its components renders.
for (const entries of [
  { en: settingsScreenEn, fr: settingsScreenFr },
  { en: settingsAppearanceEn, fr: settingsAppearanceFr },
  { en: settingsAgentsEn, fr: settingsAgentsFr },
  { en: settingsShortcutsEn, fr: settingsShortcutsFr },
  { en: settingsApprovalsEn, fr: settingsApprovalsFr },
  { en: settingsAccessEn, fr: settingsAccessFr },
])
  registerCatalog(entries);
