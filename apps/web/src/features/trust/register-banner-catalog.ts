import { trustBannerEn, trustBannerFr } from "../../i18n/catalog/trust.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the banner, which loads with the session screen: four lines, nothing of the dialog.
registerCatalog({ en: trustBannerEn, fr: trustBannerFr });
