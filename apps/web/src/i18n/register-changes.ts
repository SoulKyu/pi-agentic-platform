import { changesEn, changesFr } from "./catalog/changes.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows changes keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: changesEn, fr: changesFr });
