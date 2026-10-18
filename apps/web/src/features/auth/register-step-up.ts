import { settingsAccessEn, settingsAccessFr } from "../../i18n/catalog/settings-access.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the shell's password prompt chunk, before its dialog renders: a Save can ask for the password
// before the Settings chunk (the other owner of these strings) was ever loaded.
registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });
