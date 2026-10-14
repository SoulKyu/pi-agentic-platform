import { firstRunEn, firstRunFr } from "../../i18n/catalog/first-run.ts";
import { settingsAccessEn, settingsAccessFr } from "../../i18n/catalog/settings-access.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the stepper's chunk, before any of its components renders. The password prompt of the Pi step
// speaks with the strings of Settings › Access.
registerCatalog({ en: firstRunEn, fr: firstRunFr });
registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });
