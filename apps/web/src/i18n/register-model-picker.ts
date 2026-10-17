import { modelPickerEn, modelPickerFr } from "./catalog/model-picker.ts";
import { registerCatalog } from "./index.ts";

registerCatalog({ en: modelPickerEn, fr: modelPickerFr });
