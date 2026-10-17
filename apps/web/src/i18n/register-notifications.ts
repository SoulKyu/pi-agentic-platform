import { notificationsEn, notificationsFr } from "./catalog/notifications.ts";
import { registerCatalog } from "./index.ts";

// Only lazy code shows these keys; the catalog is not in the initial bundle.
registerCatalog({ en: notificationsEn, fr: notificationsFr });
