import { lanesEn, lanesFr } from "../../i18n/catalog/lanes.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Every lazy chunk that shows lane keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: lanesEn, fr: lanesFr });
