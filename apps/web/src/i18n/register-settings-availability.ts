import { settingsAvailabilityEn, settingsAvailabilityFr } from "./catalog/settings-availability.ts";
import { registerCatalog } from "./index.ts";

// Evaluated with the availability chunk, before its components render.
registerCatalog({ en: settingsAvailabilityEn, fr: settingsAvailabilityFr });
