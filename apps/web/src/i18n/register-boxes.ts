import { agentVmEn, agentVmFr } from "./catalog/agent-vm.ts";
import { boxesEn, boxesFr } from "./catalog/boxes.ts";
import { registerCatalog } from "./index.ts";

// The box words and the VM resource fields' (shared with the agent form): every chunk that shows a box imports this first.
registerCatalog({ en: boxesEn, fr: boxesFr });
registerCatalog({ en: agentVmEn, fr: agentVmFr });
