import type { ApprovalPlan, CallFacts, PipelineDeps, PolicyContext } from "./pipeline.ts";
import { decide } from "./decide.ts";
import { checkReadTarget } from "./read-target.ts";
import { READ_ONLY_REASON } from "./reasons.ts";
import { checkEditTarget, type EditReview } from "./target-path.ts";

const inputPath = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? (input as { path?: unknown }).path : undefined;

/** A write outside the folder or to a protected path (R14); a built-in read of pap's own files (M5R29). */
async function reviewOf(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<{ review?: EditReview; protectedRead?: EditReview }> {
  const { category } = call.kind;
  if (category === "edit") {
    const check = await checkEditTarget(inputPath(call.event.input), ctx.cwd, [deps.agentDir, deps.papHome]);
    return check.auto ? {} : { review: check.review };
  }
  if (category !== "read" || !call.kind.builtin) return {};
  const protectedRead = await checkReadTarget(call.event.toolName, call.event.input, {
    cwd: ctx.cwd,
    papHome: deps.papHome,
    agentDir: deps.agentDir,
  });
  return protectedRead ? { protectedRead } : {};
}

/** What `approvalStage` found out about a built-in read of pap's own files, by call: the MQ6 re-check needs it. */
const PROTECTED_READS = new WeakMap<CallFacts, string>();

/**
 * MQ6: whether a call a person answered must still be refused because the rules moved to read-only while the question
 * was open. `now` is the call under the new rules and taint; `call` the one the stage judged. Same rule as `decide`.
 */
export function readOnlyRefusal(
  call: CallFacts,
  now: CallFacts,
): { reason: string; modelReason: string } | null {
  const verdict = decide({
    mode: "read-only",
    category: now.kind.category,
    tainted: now.tainted,
    external: now.kind.external,
    protectedRead: PROTECTED_READS.get(call),
  });
  return verdict.decision === "block" ? { reason: "read-only", modelReason: READ_ONLY_REASON } : null;
}

/** Stage 03: the approval matrix (`decide`) over the facts of the call. It never puts input text in a reason. */
export async function approvalStage(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<ApprovalPlan> {
  const { category } = call.kind;
  const { review, protectedRead } = await reviewOf(call, ctx, deps);
  if (protectedRead) PROTECTED_READS.set(call, protectedRead.why);
  // Rules of a profile this build does not know open nothing (M1 has no unattended rules): fail closed.
  if (call.rules.profile !== "interactive")
    return {
      outcome: "block",
      reason: review?.why ?? protectedRead?.why ?? `${category} blocked`,
      modelReason: `pap-policy blocked this ${category} call.`,
    };
  const verdict = decide({
    mode: call.rules.approvalMode,
    category,
    tainted: call.tainted,
    external: call.kind.external,
    review,
    protectedRead: protectedRead?.why,
  });
  if (verdict.decision === "allow") return { outcome: "allow", reason: verdict.why };
  if (verdict.decision === "block")
    return {
      outcome: "block",
      reason: verdict.why,
      modelReason:
        call.rules.approvalMode === "read-only"
          ? READ_ONLY_REASON
          : `pap-policy blocked this ${category} call.`,
    };
  const shown = review ?? protectedRead;
  return {
    outcome: "ask",
    reason: verdict.why,
    answers: verdict.answers,
    ...(shown ? { review: shown } : {}),
    grantable: verdict.grantable,
  };
}
