import { overviewEn, overviewFr } from "./catalog/overview.ts";
import { registerCatalog } from "./index.ts";

// The Overview words: every chunk that shows the Overview imports this first.
registerCatalog({ en: overviewEn, fr: overviewFr });
