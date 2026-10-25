// packages/pi-host/src/policy/tool-allowlist.ts
import type { ToolCategory } from "@pap/contracts/pi-host";
import type { CallFacts } from "./pipeline.ts";

export const NOT_ALLOWLISTED = "tool not in the automation's allowlist";
export const NOT_ALLOWLISTED_MODEL_REASON =
  "pap-policy blocked this call: the automation that started this run does not allow this tool.";
export const UNATTENDED_UNKNOWN = "tool of unknown kind in an unattended run";
export const UNATTENDED_UNKNOWN_MODEL_REASON =
  "pap-policy blocked this call: nobody is watching this run, and this tool does not say what it does.";

type Block = { outcome: "block"; reason: string; modelReason: string };

/** Stage 02, first check: by exact name, for every call (codemode's nested calls and what `tool_search` loads included). */
export function allowlistVerdict(toolAllowlist: readonly string[] | null, toolName: string): Block | null {
  if (toolAllowlist === null) return null;
  return toolAllowlist.includes(toolName)
    ? null
    : { outcome: "block", reason: NOT_ALLOWLISTED, modelReason: NOT_ALLOWLISTED_MODEL_REASON };
}

/**
 * Stage 02, second check (decision 34, ADR 0002, owner m10a2): while the task runs, a tool whose category pap does not
 * know (an extension tool without annotations, an extension that took a built-in's name: `classifyTool` gives both
 * `unknown`) blocks instead of asking, even when the trigger lists it. Lever B's question is withheld too (`markAskable`).
 */
export function unattendedVerdict(unattended: boolean, category: ToolCategory): Block | null {
  return unattended && category === "unknown"
    ? { outcome: "block", reason: UNATTENDED_UNKNOWN, modelReason: UNATTENDED_UNKNOWN_MODEL_REASON }
    : null;
}

/**
 * The worker keeps the allowlist it was started with (`InitRecord.tools.allowlist`) and judges with the narrower of the two:
 * a late, lost or wrong `policy_update` can only narrow it, never lift it (the preset rule of ADR 0028). Lifting the list
 * ("Use my normal tools", owner m10a7) starts a new worker without it.
 */
export function pinAllowlist(
  fromRules: readonly string[] | null,
  pinned: readonly string[] | null,
): string[] | null {
  if (pinned === null) return fromRules === null ? null : [...fromRules];
  if (fromRules === null) return [...pinned];
  return fromRules.filter((name) => pinned.includes(name));
}

/** Stage 02's first two checks, in order, before the preset check. */
export function listedVerdict(call: CallFacts): Block | null {
  return (
    allowlistVerdict(call.rules.toolAllowlist, call.event.toolName) ??
    unattendedVerdict(call.rules.unattended, call.kind.category)
  );
}
