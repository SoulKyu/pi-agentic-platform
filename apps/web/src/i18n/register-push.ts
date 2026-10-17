import { pushEn, pushFr } from "./catalog/push.ts";
import { registerCatalog } from "./index.ts";

// Only lazy code shows these keys; the catalog is not in the initial bundle.
registerCatalog({ en: pushEn, fr: pushFr });
