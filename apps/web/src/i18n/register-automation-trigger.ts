import { automationTriggerEn, automationTriggerFr } from "./catalog/automation-trigger.ts";
import { automationAgentsEn, automationAgentsFr } from "./catalog/automation-agents.ts";
import { registerCatalog } from "./index.ts";

// Every lazy chunk that shows trigger editor keys imports this file first; the catalog is not in the initial bundle.
// The Tasks board's own keys (state names, source names, errors) come from `register-automation.ts`.
registerCatalog({
  en: { ...automationTriggerEn, ...automationAgentsEn },
  fr: { ...automationTriggerFr, ...automationAgentsFr },
});
