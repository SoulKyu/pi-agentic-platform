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

const AGENT_WORDS: Readonly<Record<string, MessageKey>> = {
  not_found: "boxes.agentError.not_found",
  capacity: "boxes.agentError.capacity",
  agent_paused: "boxes.agentError.agent_paused",
  vm_bundle_stale: "boxes.agentError.vm_bundle_stale",
  sandbox_unavailable: "boxes.agentError.sandbox_unavailable",
  disk_low: "boxes.agentError.disk_low",
};

/** The codes a box refusal carries: the others keep the house text (timeout, offline...). */
const BOX_CODES: ReadonlySet<string> = new Set(Object.keys(BOX_WORDS));

/** A refused START of an agent's VM, in the agent's words: no project to pick, a paused agent is resumed from its screen. */
export function agentBoxFailure(failure: unknown): MessageKey {
  const code = failure instanceof RpcError ? failure.code : "internal";
  const words = AGENT_WORDS[code];
  if (words !== undefined) return words;
  return BOX_CODES.has(code) || code === "conflict" ? "boxes.agentError.fallback" : errorKey(code);
}

/**
 * A failed box action in the three parts (DESIGN.md §11): what happened, what is intact, what to do. `scratch` words a
 * delete refused with `conflict`. A code the box has no words for keeps the house text (timeout, offline...).
 */
export function boxFailure(failure: unknown, scratch = false): MessageKey {
  const code = failure instanceof RpcError ? failure.code : "internal";
  if (code === "conflict") return scratch ? "boxes.error.conflictScratch" : "boxes.error.conflict";
  return BOX_WORDS[code] ?? errorKey(code);
}
