import { errorKey, type MessageKey } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";

const BOX_WORDS: Readonly<Record<string, MessageKey>> = {
  capacity: "boxes.error.capacity",
  sandbox_unavailable: "boxes.error.sandbox_unavailable",
  vm_bundle_stale: "boxes.error.vm_bundle_stale",
  agent_paused: "boxes.error.agent_paused",
  disk_low: "boxes.error.disk_low",
  command_failed: "boxes.error.command_failed",
  not_found: "boxes.error.not_found",
  bad_request: "boxes.error.bad_request",
  read_only: "boxes.error.read_only",
  internal: "boxes.error.internal",
};

/**
 * A failed box action in the three parts (DESIGN.md §11): what happened, what is intact, what to do. `scratch` words a
 * delete refused with `conflict`. A code the box has no words for keeps the house text (timeout, offline...).
 */
export function boxFailure(failure: unknown, scratch = false): MessageKey {
  const code = failure instanceof RpcError ? failure.code : "internal";
  if (code === "conflict") return scratch ? "boxes.error.conflictScratch" : "boxes.error.conflict";
  return BOX_WORDS[code] ?? errorKey(code);
}
