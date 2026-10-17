import { inboxEn, inboxFr } from "./catalog/inbox.ts";
import { inboxAgentsEn, inboxAgentsFr } from "./catalog/inbox-agents.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows Inbox keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({ en: inboxEn, fr: inboxFr });
registerCatalog({ en: inboxAgentsEn, fr: inboxAgentsFr });
