import type { ApprovalPlan, CallFacts, PolicyContext, StageResult } from "./pipeline.ts";

export const UNCHECKED_REASON =
  "pap could not check this command against the blocked-command list. Read it before you allow it.";

export type Unchecked = Extract<StageResult, { outcome: "unchecked" }>;

/** Only stage 01 may say a call was not judged; any other stage returning it, or any unknown outcome, is a fault (fail closed). */
export function checkStage(result: StageResult, mayBeUnchecked = false): StageResult {
  const { outcome } = result;
  if (outcome === "pass" || outcome === "skip" || outcome === "block") return result;
  if (outcome === "unchecked" && mayBeUnchecked) return result;
  throw new TypeError("a stage returned an outcome the pipeline does not know");
}

/** Whether a person can be asked about a call the denylist could not read: a UI, interactive rules, not read-only. */
export const canAskUnchecked = (ctx: PolicyContext, call: CallFacts): boolean =>
  ctx.hasUI && call.rules.profile === "interactive" && call.rules.approvalMode !== "read-only";

/**
 * The question for a call stage 01 could not read: stage 03's verdict made into a deny / once question that no grant
 * can skip (the call was not judged, so no rule may remember it). A block of stage 03 stays a block.
 */
export function uncheckedPlan(plan: ApprovalPlan, unchecked: Unchecked | null): ApprovalPlan {
  if (unchecked === null || plan.outcome === "block") return plan;
  return {
    outcome: "ask",
    reason: plan.outcome === "ask" ? `${UNCHECKED_REASON} ${plan.reason}` : UNCHECKED_REASON,
    answers: ["deny", "once"],
    ...(plan.outcome === "ask" && plan.review ? { review: plan.review } : {}),
    grantable: false,
  };
}
