import { sessionFilesEn, sessionFilesFr } from "../../../i18n/catalog/session-files.ts";
import { registerCatalog } from "../../../i18n/index.ts";

// Evaluated with the composer's parts, before any of them renders.
registerCatalog({ en: sessionFilesEn, fr: sessionFilesFr });
