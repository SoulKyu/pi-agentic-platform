import { healthEn, healthFr } from "./catalog/health.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows Health keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: healthEn, fr: healthFr });
