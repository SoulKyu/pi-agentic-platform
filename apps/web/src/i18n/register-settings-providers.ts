import { settingsProvidersEn, settingsProvidersFr } from "./catalog/settings-providers.ts";
import { registerCatalog } from "./index.ts";

// Evaluated with the Settings › Models chunk, before the list or the form renders.
registerCatalog({ en: settingsProvidersEn, fr: settingsProvidersFr });
