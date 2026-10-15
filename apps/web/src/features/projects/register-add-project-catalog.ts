import { addProjectEn, addProjectFr } from "../../i18n/catalog/add-project.ts";
import { registerCatalog } from "../../i18n/index.ts";

// Evaluated with the dialog's own chunk, before any of its components renders.
registerCatalog({ en: addProjectEn, fr: addProjectFr });
