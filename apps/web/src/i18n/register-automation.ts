import { automationEn, automationFr } from "./catalog/automation.ts";
import { automationAgentsEn, automationAgentsFr } from "./catalog/automation-agents.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows Tasks board keys imports this file first; the catalog is not in the initial bundle.
registerCatalog({
  en: { ...automationEn, ...automationAgentsEn },
  fr: { ...automationFr, ...automationAgentsFr },
});
