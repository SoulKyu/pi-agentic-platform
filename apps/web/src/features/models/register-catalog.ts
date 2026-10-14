import { settingsModelsEn, settingsModelsFr } from "../../i18n/catalog/settings-models.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the section's own chunk, before any of its components renders.
registerCatalog({ en: settingsModelsEn, fr: settingsModelsFr });
