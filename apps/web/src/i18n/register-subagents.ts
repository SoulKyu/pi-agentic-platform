import { subagentsEn, subagentsFr } from "./catalog/subagents.ts";
import { registerCatalog } from "./index.ts";

registerCatalog({ en: subagentsEn, fr: subagentsFr });
