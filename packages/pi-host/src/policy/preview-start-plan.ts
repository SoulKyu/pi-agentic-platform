import type { PlatformOp, ToolCategory } from "@pap/contracts/pi-host";
import { decide } from "./decide.ts";
import type { ApprovalPlan, CallFacts } from "./pipeline.ts";
import { READ_ONLY_REASON } from "./reasons.ts";

/** The platform ops that run a command in the session shell's sandbox (UX2-R26). */
const RUNS_A_COMMAND: ReadonlySet<PlatformOp> = new Set<PlatformOp>(["preview.start"]);

/**
 * A platform op whose `command` runs in the guest's own bwrap, as the sandboxed shell's does. One predicate decides both its
 * `edit` category (stage 03 and the MQ6 re-check) and its exemption from stage 02's "only pap's bash runs commands".
 */
export const runsACommand = (kind: CallFacts["kind"]): boolean =>
  kind.platform !== undefined && RUNS_A_COMMAND.has(kind.platform.op);

/**
 * The category a call is judged by at stage 03 and at the MQ6 re-check alike (red team I8): every platform tool is a `read`
 * (`platformKind`), except an op that runs a command, which is an `edit`, as the sandboxed shell is (M11R30).
 */
export const judgedCategory = (kind: CallFacts["kind"]): ToolCategory =>
  runsACommand(kind) ? "edit" : kind.category;

export const PREVIEW_START_REASON = "preview_start runs a command in your VM, as your shell would.";

/**
 * UX2-R26: `preview_start` never passes where the shell's own commands would not. Read-only blocks it; `supervised` and the
 * read-only preset ask Deny / Allow once, never a grant; `auto-accept-edits` and `full-access` let it run. Taint changes
 * nothing (decision 5), so the matrix is asked untainted; the denylist (stage 01) has already judged its `command`.
 */
export function previewStartPlan(call: CallFacts): ApprovalPlan {
  const verdict = decide({
    mode: call.rules.approvalMode,
    category: "edit",
    tainted: false,
    external: false,
  });
  if (verdict.decision === "block")
    return { outcome: "block", reason: verdict.why, modelReason: READ_ONLY_REASON };
  if (verdict.decision === "allow" && !call.rules.readOnlyPreset)
    return { outcome: "allow", reason: "preview_start: commands run in this mode" };
  return {
    outcome: "ask",
    title: "pap: start a preview?",
    reason: PREVIEW_START_REASON,
    answers: ["deny", "once"],
    grantable: false,
  };
}
