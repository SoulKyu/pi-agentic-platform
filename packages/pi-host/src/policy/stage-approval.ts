import type { ApprovalAnswer, ToolCategory } from "@pap/contracts";
import { type Decision, decide, decideEdit } from "./decide.ts";
import type { ApprovalPlan, CallFacts, PipelineDeps, PolicyContext } from "./pipeline.ts";
import { checkEditTarget, type EditReview } from "./target-path.ts";

/** The answers a card offers, in DESIGN.md order (Deny / Session / Always / Allow once). */
export function answersFor(category: ToolCategory, review: EditReview | undefined): ApprovalAnswer[] {
  // A write outside the project or to a protected path is judged one call at a time: no grant covers the next one.
  if (review) return ["deny", "once"];
  // A tool pap cannot classify may do anything: it is never remembered beyond this worker.
  if (category === "unknown") return ["deny", "session", "once"];
  return ["deny", "session", "always", "once"];
}

async function decideCall(
  call: CallFacts,
  ctx: PolicyContext,
  protectedRoots: readonly string[],
): Promise<{ decision: Decision; review?: EditReview }> {
  const { category } = call.kind;
  if (category !== "edit") return { decision: decide(category, call.rules) };
  const target =
    typeof call.event.input === "object" && call.event.input !== null
      ? (call.event.input as { path?: unknown }).path
      : undefined;
  const check = await checkEditTarget(target, ctx.cwd, protectedRoots);
  return check.auto
    ? { decision: decideEdit(call.rules, true) }
    : { decision: decideEdit(call.rules, false), review: check.review };
}

/** Stage 03 as M2 judged a call (Task 6 rewrites it): the category and the mode decide, an edit outside the folder asks. */
export async function approvalStage(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<ApprovalPlan> {
  const { category } = call.kind;
  const { decision, review } = await decideCall(call, ctx, [deps.agentDir, deps.papHome]);
  if (decision === "allow") return { outcome: "allow", reason: `${category} allowed` };
  if (decision === "block")
    return {
      outcome: "block",
      reason: review?.why ?? `${category} blocked`,
      modelReason: `pap-policy blocked this ${category} call.`,
    };
  return {
    outcome: "ask",
    reason: review?.why ?? `${category} asks`,
    answers: answersFor(category, review),
    ...(review ? { review } : {}),
    grantable: review === undefined,
  };
}
