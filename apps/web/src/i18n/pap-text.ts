import { PAP_TEXT } from "@pap/contracts";
import { type MessageKey, registerCatalog, type Translate } from "./index.ts";
import { papTextEn, papTextFr } from "./catalog/pap-text.ts";

registerCatalog({ en: papTextEn, fr: papTextFr });

// The texts the daemon writes in English into stored rows: shown in the viewer's language (T12).
const KEYS: ReadonlyMap<string, MessageKey> = new Map([
  [PAP_TEXT.reminderTitle, "papText.reminderTitle" as MessageKey],
  [PAP_TEXT.reminderNotDelivered, "papText.reminderNotDelivered" as MessageKey],
]);

/** `text` in the viewer's language when pap wrote it; any other text, as it is. */
export function papText(t: Translate, text: string): string {
  const key = KEYS.get(text);
  return key === undefined ? text : t(key);
}
