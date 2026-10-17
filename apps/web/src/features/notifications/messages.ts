import type { MessageKey } from "../../i18n/index.ts";
import type { EnableResult } from "./push-client.ts";

/** The sentence for a refused enable, shared by the banner and Settings. */
export function enableFailureKey(reason: Extract<EnableResult, { ok: false }>["reason"]): MessageKey {
  switch (reason) {
    case "refused":
      return "push.enable.refused";
    case "capacity":
      return "push.enable.capacity";
    case "rpc":
      return "push.enable.failed";
    case "supported":
      return "push.enable.failed";
    default:
      return `push.support.${reason}`;
  }
}
