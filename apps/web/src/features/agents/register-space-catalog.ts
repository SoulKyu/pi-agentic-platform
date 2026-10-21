import { agentComposeEn, agentComposeFr } from "../../i18n/catalog/agent-compose.ts";
import { agentEgressEn, agentEgressFr } from "../../i18n/catalog/agent-egress.ts";
import { agentFilesEn, agentFilesFr } from "../../i18n/catalog/agent-files.ts";
import { agentSafetyEn, agentSafetyFr } from "../../i18n/catalog/agent-safety.ts";
import { agentSpaceEn, agentSpaceFr } from "../../i18n/catalog/agent-space.ts";
import { agentStatusEn, agentStatusFr } from "../../i18n/catalog/agent-status.ts";
import { registerCatalog } from "../../i18n/index.ts";

registerCatalog({ en: agentSpaceEn, fr: agentSpaceFr });
registerCatalog({ en: agentStatusEn, fr: agentStatusFr });
registerCatalog({ en: agentComposeEn, fr: agentComposeFr });
registerCatalog({ en: agentSafetyEn, fr: agentSafetyFr });
registerCatalog({ en: agentEgressEn, fr: agentEgressFr });
registerCatalog({ en: agentFilesEn, fr: agentFilesFr });
