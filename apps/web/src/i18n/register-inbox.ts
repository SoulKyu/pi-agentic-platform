import { inboxEn, inboxFr } from "./catalog/inbox.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows Inbox keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: inboxEn, fr: inboxFr });
