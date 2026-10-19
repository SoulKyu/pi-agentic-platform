import { agentVmEn, agentVmFr } from "../../i18n/catalog/agent-vm.ts";
import { registerCatalog } from "../../i18n/index.ts";

// The VM strings alone: the agent rail (initial assets) says why a greyed-out agent cannot start, and must not pull the
// agent form's catalogs in with them (build-output.int.test.ts keeps those lazy).
registerCatalog({ en: agentVmEn, fr: agentVmFr });
