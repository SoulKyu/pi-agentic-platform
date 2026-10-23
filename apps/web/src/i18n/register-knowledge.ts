import { knowledgeEn, knowledgeFr } from "./catalog/knowledge.ts";
import { registerCatalog } from "./index.ts";

registerCatalog({ en: knowledgeEn, fr: knowledgeFr });
