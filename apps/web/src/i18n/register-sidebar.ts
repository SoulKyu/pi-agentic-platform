import { sidebarEn, sidebarFr } from "./catalog/sidebar.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows sidebar keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: sidebarEn, fr: sidebarFr });
