import { previewsEn, previewsFr } from "./catalog/previews.ts";
import { registerCatalog } from "./index.ts";

// The preview words: every chunk that shows a preview imports this first (the marker row in build-output.markers.ts keeps them lazy).
registerCatalog({ en: previewsEn, fr: previewsFr });
