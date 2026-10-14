import { filesEn, filesFr } from "./catalog/files.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows files keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: filesEn, fr: filesFr });
