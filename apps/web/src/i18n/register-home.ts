import { homeEn, homeFr } from "./catalog/home.ts";
import { registerCatalog } from "./index.ts";

// Every chunk that shows home keys (the home's body, its picker) imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: homeEn, fr: homeFr });
