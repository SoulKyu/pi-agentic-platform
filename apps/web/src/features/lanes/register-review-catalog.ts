import { laneReviewEn, laneReviewFr } from "../../i18n/catalog/lane-review.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Every lazy chunk that shows review keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: laneReviewEn, fr: laneReviewFr });
