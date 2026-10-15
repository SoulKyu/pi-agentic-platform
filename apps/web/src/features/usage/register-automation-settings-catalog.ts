import { settingsAutomationEn, settingsAutomationFr } from "../../i18n/catalog/settings-automation.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the section's own chunk, before any of its components renders.
registerCatalog({ en: settingsAutomationEn, fr: settingsAutomationFr });
