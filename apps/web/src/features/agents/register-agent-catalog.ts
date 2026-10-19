import { agentSettingsEn, agentSettingsFr } from "../../i18n/catalog/agent-settings.ts";
import { agentVmEn, agentVmFr } from "../../i18n/catalog/agent-vm.ts";
import { settingsAgentsEn, settingsAgentsFr } from "../../i18n/catalog/settings-agents.ts";
import { registerCatalog } from "../../i18n/index.ts";

registerCatalog({ en: agentSettingsEn, fr: agentSettingsFr });
registerCatalog({ en: settingsAgentsEn, fr: settingsAgentsFr });
registerCatalog({ en: agentVmEn, fr: agentVmFr });
