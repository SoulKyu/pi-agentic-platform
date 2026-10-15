import { laneCompareEn, laneCompareFr } from "../../i18n/catalog/lane-compare.ts";
import { lanesEn, lanesFr } from "../../i18n/catalog/lanes.ts";
import { registerCatalog } from "../../i18n/index.ts";

// The compare tab shows the lane catalog's keys too (the tainted question, Cancel, Close).
registerCatalog({ en: { ...lanesEn, ...laneCompareEn }, fr: { ...lanesFr, ...laneCompareFr } });
