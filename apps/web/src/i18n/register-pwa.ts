import { pwaEn, pwaFr } from "./catalog/pwa.ts";
import { registerCatalog } from "./index.ts";

// Only the lazy update banner shows these keys; the catalog is not in the initial bundle.
registerCatalog({ en: pwaEn, fr: pwaFr });
