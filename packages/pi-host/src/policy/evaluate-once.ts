import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { CallAuditEntry, GuardRule, StageId, ToolCategory } from "@pap/contracts";
import { GUARD_RULES } from "@pap/contracts";
import { autonomous } from "./agent-stage.ts";
import { alwaysScopesOf, patternGrant, rememberScope, scopeOffered } from "./pattern-grants.ts";
import { describeCall } from "./describe-call.ts";
import { GUARD_MODEL_REASON } from "./run-guard.ts";
import type { CallFacts, PipelineDeps, PolicyContext, PolicyEvent, Stages } from "./pipeline.ts";
import type { ToolKind } from "./tool-kind.ts";
import { clipUnits, createTrail } from "./trail.ts";
import { markAskable, checkStage, type Unchecked, uncheckedCard, uncheckedPlan } from "./unchecked.ts";

export const DENIED_REASON = "Denied by the user.";
export const FAIL_CLOSED_REASON = "pap-policy could not evaluate this call, so it was blocked (fail closed).";
export const TOO_LONG_REASON = "too long to review — split the work";
export const NO_RULES = "no valid policy rules";
export const MAX_ENTRY_REASON = 1024;
type CallDecision = CallAuditEntry["decision"];

const TITLES: Readonly<Record<ToolCategory, string>> = {
  read: "Allow reading?",
  edit: "Allow this edit?",
  exec: "Run a command?",
  network: "Allow a network request?",
  "external-write": "Allow this tool?",
  unknown: "Allow this tool?",
};

export interface Evaluation {
  readonly result: ToolCallEventResult | undefined;
  readonly entry: CallAuditEntry;
  /** A person answered: never asked again (M5R12). */
  readonly answered: boolean;
  readonly call: CallFacts | null;
  /** The guard rule a person's "once" released, if the question was the guard's. */
  readonly guardReleased: GuardRule | null;
}
export interface Ids {
  readonly toolCallId: string;
  readonly parentToolCallId?: string;
  readonly tool: string;
}

/** What does not depend on the rules, worked out once per call. */
export interface Prepared {
  readonly kind: ToolKind;
  readonly exec: boolean;
  readonly args: string;
  readonly key: string;
}

export async function evaluateOnce(
  event: PolicyEvent,
  ctx: PolicyContext,
  deps: PipelineDeps,
  stages: Stages,
  ids: Ids,
  { kind, exec, args, key }: Prepared,
): Promise<Evaluation> {
  const trail = createTrail(deps.redactReason);
  const finish = (
    call: CallFacts | null,
    decision: CallDecision,
    reason: string | undefined,
    result: ToolCallEventResult | undefined,
    extra: { answered?: boolean; guardReleased?: GuardRule | null } = {},
  ): Evaluation => ({
    result,
    entry: {
      kind: "call",
      ...ids,
      category: kind.category,
      decision,
      ...(reason === undefined ? {} : { reason: clipUnits(deps.redactReason(reason), MAX_ENTRY_REASON) }),
      stages: trail.list(),
      args,
    },
    answered: extra.answered ?? false,
    call,
    guardReleased: extra.guardReleased ?? null,
  });
  const rules = deps.rules();
  if (rules === null) {
    trail.add("03", "block", NO_RULES);
    trail.skipFrom("01", NO_RULES);
    return finish(null, "block", NO_RULES, { block: true, reason: FAIL_CLOSED_REASON });
  }
  // W5-R53: one flag for decide, the grants, the read-only cover and the offered scopes. The result's taint still comes from the report.
  const sessionTainted = deps.taint.current();
  const lifted = sessionTainted && autonomous({ kind, rules });
  const call: CallFacts = {
    event,
    kind,
    rules,
    cwd: ctx.cwd,
    tainted: sessionTainted && !lifted,
    ...(lifted ? { autonomyLifted: true } : {}),
    key,
    exec,
  };
  const blocked = (stage: StageId, next: StageId, reason: string, modelReason: string): Evaluation => {
    trail.add(stage, "block", reason);
    trail.skipFrom(next, `blocked at stage ${stage}`);
    return finish(call, "block", reason, { block: true, reason: modelReason });
  };

  let unchecked: Unchecked | null = null;
  for (const [stage, next, run] of [
    ["01", "02", () => stages.denylist(call)],
    ["02", "03", () => stages.egress(call)],
  ] as const) {
    const verdict = checkStage(run(), stage === "01");
    // A command the reader could not check is asked about where a person can answer, and blocks where none can.
    if (verdict.outcome === "unchecked" && markAskable(ctx, call)) unchecked = verdict;
    else if (verdict.outcome === "block" || verdict.outcome === "unchecked")
      return blocked(stage, next, verdict.reason, verdict.modelReason);
    trail.add(stage, verdict.outcome === "unchecked" ? "ask" : verdict.outcome, verdict.reason);
  }
  const plan = uncheckedPlan(await stages.approval(call, ctx, deps), unchecked);
  if (plan.outcome === "block") return blocked("03", "04", plan.reason, plan.modelReason);
  if (plan.outcome !== "allow" && plan.outcome !== "ask")
    throw new TypeError("the approval stage returned an unknown outcome");
  const guard = stages.guard(call);
  if (guard.outcome !== "pass" && guard.outcome !== "trip")
    throw new TypeError("the guard returned an unknown outcome");
  if (guard.outcome === "trip" && !(GUARD_RULES as readonly string[]).includes(guard.rule))
    throw new TypeError("the guard tripped without a known rule");
  const trip = guard.outcome === "trip" ? guard : null;
  if (plan.outcome === "allow" && !trip) {
    trail.add("03", "allow", plan.reason);
    trail.add("04", "pass");
    return finish(call, "allow", plan.reason, undefined);
  }
  // From here a person is asked: by the matrix, by the guard, or by both in one question.
  const review = plan.outcome === "ask" ? plan.review : undefined;
  const grantable = plan.outcome === "ask" && plan.grantable && !trip;
  const answers = trip || plan.outcome !== "ask" ? (["deny", "once"] as const) : plan.answers;
  const verdict03 = plan.outcome === "ask" ? "ask" : "allow";
  const auditReason = plan.outcome === "ask" ? (plan.auditReason ?? plan.reason) : plan.reason;
  if (!ctx.hasUI) {
    if (!trip) return blocked("03", "04", "no UI to ask", `pap-policy blocked this ${kind.category} call.`);
    trail.add("03", verdict03, auditReason);
    trail.add("04", "block", trip.reason);
    return finish(call, "block", trip.reason, { block: true, reason: GUARD_MODEL_REASON });
  }
  const description = describeCall(event.toolName, event.input, { exec, review });
  if (!description.reviewable) return blocked("03", "04", "too long to review", TOO_LONG_REASON);
  const own = plan.outcome === "ask" ? plan.title : undefined;
  // A guard question offers no host answer, so the plan's "if you allow it, the shell can reach the host" would mislead.
  const planReason =
    plan.outcome === "ask" && trip && plan.host !== undefined
      ? `network_request asks for ${plan.host}. Allow once runs this call only: no host is granted for this thread.`
      : plan.reason;
  if (grantable) {
    const always =
      rules.alwaysAllow.some((rule) => rule.tool === event.toolName && rule.key === key) ||
      deps.grants.hasProvisionalAlways(key);
    const exact = deps.grants.hasSession(key) ? "session rule" : always ? "always rule" : null;
    const grantedBy = exact ?? (await patternGrant(call, ctx, deps));
    if (grantedBy) {
      trail.add("03", "allow", grantedBy);
      trail.add("04", "pass");
      return finish(call, "allow", grantedBy, undefined);
    }
  }
  const host = plan.outcome === "ask" && !trip && answers.includes("host") ? plan.host : undefined;
  const scopes =
    grantable && answers.includes("always")
      ? alwaysScopesOf(call, { cwd: ctx.cwd, cdPath: deps.shell().cdPath })
      : undefined;
  const askedAt = deps.grants.version();
  const causes = call.tainted ? deps.taint.causes?.() : undefined;
  const outcome = await deps.ask(
    {
      category: kind.category,
      ...uncheckedCard(
        unchecked,
        trip,
        rules.guard,
        own ?? TITLES[kind.category],
        own === undefined ? description.message : `${planReason}\n${description.message}`,
      ),
      tool: ids.tool,
      key,
      toolCallId: ids.toolCallId,
      answers,
      ...(scopes ? { alwaysScopes: scopes } : {}),
      ...(host === undefined ? {} : { host }),
      tainted: call.tainted,
      ...(causes !== undefined && (causes.list.length > 0 || causes.older > 0)
        ? { taintCauses: causes }
        : {}),
      ...(trip ? { guard: trip.rule } : {}),
    },
    ctx.signal,
  );
  trail.add("03", verdict03, auditReason);
  if (trip) trail.add("04", "ask", trip.reason);
  else trail.add("04", "pass");
  const answered = { answered: true };
  if (outcome.closed)
    return finish(call, "denied", "dialog closed", { block: true, reason: FAIL_CLOSED_REASON }, answered);
  // An answer that was not offered is a refusal, whatever the channel says.
  const scope = outcome.scope ?? "exact";
  const offered =
    answers.includes(outcome.answer) && (outcome.answer !== "always" || scopeOffered(scope, scopes));
  if (!offered || outcome.answer === "deny")
    return finish(
      call,
      "denied",
      offered ? (review?.why ?? trip?.reason) : "answer not offered",
      { block: true, reason: trip ? GUARD_MODEL_REASON : DENIED_REASON },
      answered,
    );
  if (grantable && outcome.answer === "session") deps.grants.rememberSession(key);
  if (grantable && outcome.answer === "always") rememberScope(deps.grants, scope, scopes, call, askedAt);
  const said = outcome.answer === "always" && scope !== "exact" ? `always (${scope})` : outcome.answer;
  return finish(call, "approved", review ? `answer: ${said}; ${review.why}` : `answer: ${said}`, undefined, {
    answered: true,
    guardReleased: trip && outcome.answer === "once" ? trip.rule : null,
  });
}
