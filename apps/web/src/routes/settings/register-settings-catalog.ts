import { registerCatalog } from "../../i18n/index.ts";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";

// Evaluated with the Settings chunk, before any of its components renders.
registerCatalog({ en: settingsScreenEn, fr: settingsScreenFr });
