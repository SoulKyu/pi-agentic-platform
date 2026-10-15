import { laneNewEn, laneNewFr } from "../../i18n/catalog/lane-new.ts";
import { lanesEn, lanesFr } from "../../i18n/catalog/lanes.ts";
import { registerCatalog } from "../../i18n/index.ts";

registerCatalog({ en: { ...lanesEn, ...laneNewEn }, fr: { ...lanesFr, ...laneNewFr } });
