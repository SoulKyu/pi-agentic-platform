import { githubEn, githubFr } from "./catalog/github.ts";
import { registerCatalog } from "./index.ts";

registerCatalog({ en: githubEn, fr: githubFr });
