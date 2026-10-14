import { settingsSkillsEn, settingsSkillsFr } from "../../i18n/catalog/settings-skills.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the section's own chunk, before any of its components renders.
registerCatalog({ en: settingsSkillsEn, fr: settingsSkillsFr });
