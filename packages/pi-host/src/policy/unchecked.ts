import type { GuardRule } from "@pap/contracts";
import { guardTitle } from "./run-guard.ts";
import type { ApprovalPlan, CallFacts, PolicyContext, StageResult } from "./pipeline.ts";

export const UNCHECKED_REASON =
  "pap could not check this command against the blocked-command list. Read it before you allow it.";

/** Calls whose evaluation was itself unchecked and asked. */
const WAS_UNCHECKED = new WeakSet<CallFacts>();

export type Unchecked = Extract<StageResult, { outcome: "unchecked" }>;

/** Only stage 01 may say a call was not judged; any other stage returning it, or any unknown outcome, is a fault (fail closed). */
export function checkStage(result: StageResult, mayBeUnchecked = false): StageResult {
  const { outcome } = result;
  if (outcome === "pass" || outcome === "skip" || outcome === "block") return result;
  if (outcome === "unchecked" && mayBeUnchecked) return result;
  throw new TypeError("a stage returned an outcome the pipeline does not know");
}

/**
 * Whether a person can be asked about a call the denylist could not read: a UI, attended rules (an isolated task is unattended), not read-only. When
 * they can, the call is marked: only its re-check may see `unchecked` again.
 */
export function markAskable(ctx: PolicyContext, call: CallFacts): boolean {
  const yes =
    ctx.hasUI &&
    (call.rules.profile === "interactive" || call.rules.profile === "agent-thread") &&
    call.rules.approvalMode !== "read-only" &&
    !call.rules.unattended;
  if (yes) WAS_UNCHECKED.add(call);
  return yes;
}

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

/** The MQ6 re-check: a block refuses an answered call, and so does `unchecked` when the question was not about it. */
export const refuses = (
  verdict: StageResult,
  call: CallFacts,
): verdict is Extract<StageResult, { outcome: "block" | "unchecked" }> =>
  verdict.outcome === "block" || (verdict.outcome === "unchecked" && !WAS_UNCHECKED.has(call));

/** The card: the unchecked reason as the title, or as the start of the message's first line (before the size) next to a guard's title. */
export function uncheckedCard(
  unchecked: Unchecked | null,
  trip: { readonly rule: GuardRule } | null,
  guard: Parameters<typeof guardTitle>[1],
  title: string,
  message: string,
): { title: string; message: string } {
  const shown = trip ? guardTitle(trip.rule, guard) : title;
  if (unchecked === null) return { title: shown, message };
  return trip
    ? { title: shown, message: `${UNCHECKED_REASON} ${message}` }
    : { title: UNCHECKED_REASON, message };
}
