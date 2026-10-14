import { terminalEn, terminalFr } from "./catalog/terminal.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows terminal keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: terminalEn, fr: terminalFr });
