import { landingEn, landingFr } from "./catalog/landing.ts";
import { registerCatalog } from "./index.ts";

// Only the lazy landing shows these keys; the catalog is not in the initial bundle.
registerCatalog({ en: landingEn, fr: landingFr });
