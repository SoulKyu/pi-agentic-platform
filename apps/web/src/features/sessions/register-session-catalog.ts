import { sessionScreenEn, sessionScreenFr } from "../../i18n/catalog/session-screen.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the session chunk, before any of its components renders.
registerCatalog({ en: sessionScreenEn, fr: sessionScreenFr });
