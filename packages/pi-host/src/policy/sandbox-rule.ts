import type { CallFacts, StageResult } from "./pipeline.ts";

export const UNSANDBOXED_SHELL = "unsandboxed shell in a sandboxed agent";
export const UNSANDBOXED_SHELL_MODEL_REASON =
  "pap-policy blocked this call: this agent's commands run only in its sandbox, and this shell is not the sandboxed one.";

/** Stage 02, after the allowlist and the unattended block (M11R34): in a sandbox-required profile, only pap's `bash` runs commands. */
export function sandboxVerdict(call: CallFacts): StageResult | null {
  if (!call.rules.sandbox?.required) return null;
  const commandBearing =
    call.kind.category === "exec" ||
    typeof (call.event.input as { command?: unknown } | null)?.command === "string";
  if (!commandBearing || call.kind.sandboxed === true) return null;
  return { outcome: "block", reason: UNSANDBOXED_SHELL, modelReason: UNSANDBOXED_SHELL_MODEL_REASON };
}
