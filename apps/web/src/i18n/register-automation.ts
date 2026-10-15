import { automationEn, automationFr } from "./catalog/automation.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows Tasks board keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: automationEn, fr: automationFr });
