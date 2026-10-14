import { trustEn, trustFr } from "../../i18n/catalog/trust.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the dialog's own chunk, before any of its components renders.
registerCatalog({ en: trustEn, fr: trustFr });
