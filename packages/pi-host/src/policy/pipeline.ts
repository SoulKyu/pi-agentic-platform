import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type {
  ApprovalAnswer,
  CallAuditEntry,
  GuardRule,
  PolicyAuditEntry,
  PolicyRules,
  StageId,
  ToolCategory,
} from "@pap/contracts";
import type { ApprovalAsk, ApprovalOutcome } from "../approvals.ts";
import { auditArgs, InputTooLarge, UNREADABLE_INPUT } from "./audit-args.ts";
import { describeCall } from "./describe-call.ts";
import { grantKey, grantPayload } from "./grant-key.ts";
import type { PolicyGrants } from "./grants.ts";
import { approvalStage } from "./stage-approval.ts";
import type { EditReview } from "./target-path.ts";
import { classifyTool, type ToolFacts, type ToolKind } from "./tool-kind.ts";
import { clipUnits, createTrail } from "./trail.ts";

export const DENIED_REASON = "Denied by the user.";
export const FAIL_CLOSED_REASON = "pap-policy could not evaluate this call, so it was blocked (fail closed).";
export const TOO_LONG_REASON = "too long to review — split the work";
export const READ_ONLY_REASON = "pap-policy blocked this call: the session is read-only.";
export const TOO_LARGE_REASON = "pap-policy blocked this call: its input is too large to judge.";
const NO_RULES = "no valid policy rules";
const MAX_FIELD = 256;
const MAX_ENTRY_REASON = 1024;
/** Evaluations of one call before a moving rules version blocks it (M5R12). */
const MAX_ATTEMPTS = 3;

const TITLES: Readonly<Record<ToolCategory, string>> = {
  read: "Allow reading?",
  edit: "Allow this edit?",
  exec: "Run a command?",
  network: "Allow a network request?",
  "external-write": "Allow this tool?",
  unknown: "Allow this tool?",
};

export interface PolicyEvent {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly parentToolCallId?: string | undefined;
}
export interface PolicyContext {
  readonly hasUI: boolean;
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
}
export interface CallFacts {
  readonly event: PolicyEvent;
  readonly kind: ToolKind;
  readonly rules: PolicyRules;
  readonly cwd: string;
  readonly tainted: boolean;
  /** The grant key of the exact call (M2R65). */
  readonly key: string;
  /** A built-in shell call: its payload is the command alone. */
  readonly exec: boolean;
}
export type StageResult =
  | { readonly outcome: "pass" | "skip"; readonly reason?: string }
  | { readonly outcome: "block"; readonly reason: string; readonly modelReason: string };
export type ApprovalPlan =
  | { readonly outcome: "allow"; readonly reason: string }
  | { readonly outcome: "block"; readonly reason: string; readonly modelReason: string }
  | {
      readonly outcome: "ask";
      readonly reason: string;
      readonly answers: readonly ApprovalAnswer[];
      readonly review?: EditReview;
      /** Session and always grants may skip this question (an ask from the matrix, not from taint or review). */
      readonly grantable: boolean;
    };
export type GuardResult =
  | { readonly outcome: "pass" }
  | { readonly outcome: "trip"; readonly rule: GuardRule; readonly reason: string };
type CallDecision = CallAuditEntry["decision"];
export interface Stages {
  denylist(call: CallFacts): StageResult;
  egress(call: CallFacts): StageResult;
  approval(call: CallFacts, ctx: PolicyContext, deps: PipelineDeps): Promise<ApprovalPlan>;
  guard(call: CallFacts): GuardResult;
  /**
   * Told the final decision of a call once (the guard counts here, Task 7). `guardReleased`: the person answered "once" to
   * a question the guard raised, so that guard's counter restarts.
   */
  commit(call: CallFacts, decision: CallDecision, guardReleased: GuardRule | null): void;
  /** For a call that runs: puts secret values back where the model wrote markers (Task 8b); returns how many. */
  restore(call: CallFacts): number;
}

export interface PipelineDeps {
  rules(): PolicyRules | null;
  rulesVersion(): number;
  readonly grants: PolicyGrants;
  ask(request: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalOutcome>;
  audit(entry: PolicyAuditEntry): void;
  readonly agentDir: string;
  readonly papHome: string;
  toolFacts(toolName: string): ToolFacts | undefined;
  readonly taint: { current(): boolean };
  redact(text: string): string;
  readonly stages?: Partial<Stages>;
}

const PASS_THROUGH: Omit<Stages, "approval"> = {
  denylist: () => ({ outcome: "skip", reason: "not in force" }),
  egress: () => ({ outcome: "skip", reason: "no egress list" }),
  guard: () => ({ outcome: "pass" }),
  commit: () => {},
  restore: () => 0,
};

interface Evaluation {
  readonly result: ToolCallEventResult | undefined;
  readonly entry: CallAuditEntry;
  /** A person answered: never asked again (M5R12). */
  readonly answered: boolean;
  readonly call: CallFacts | null;
  /** The guard rule a person's "once" released, if the question was the guard's. */
  readonly guardReleased: GuardRule | null;
}
interface Ids {
  readonly toolCallId: string;
  readonly parentToolCallId?: string;
  readonly tool: string;
}

/** What does not depend on the rules, worked out once per call. */
interface Prepared {
  readonly kind: ToolKind;
  readonly exec: boolean;
  readonly args: string;
  readonly key: string;
}

function checkStage(result: StageResult): StageResult {
  if (result.outcome === "pass" || result.outcome === "skip" || result.outcome === "block") return result;
  throw new TypeError("a stage returned an outcome the pipeline does not know");
}

export const errorClass = (error: unknown): string =>
  (error instanceof Error ? error.constructor.name : typeof error)
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 64) || "unknown";

export async function evaluateToolCall(
  event: PolicyEvent,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<ToolCallEventResult | undefined> {
  const stages: Stages = { ...PASS_THROUGH, approval: approvalStage, ...deps.stages };
  const ids: Ids = {
    toolCallId: clipUnits(event.toolCallId, MAX_FIELD),
    ...(event.parentToolCallId !== undefined
      ? { parentToolCallId: clipUnits(event.parentToolCallId, MAX_FIELD) }
      : {}),
    tool: clipUnits(event.toolName, MAX_FIELD),
  };
  // What the audit can say of the call if the evaluation dies: the real category and arguments once they are known.
  let audited: { category: ToolCategory; args: string } = { category: "unknown", args: UNREADABLE_INPUT };
  const fail = (reason: string): CallAuditEntry => {
    const trail = createTrail();
    trail.add("03", "block", reason);
    trail.skipFrom("01", reason);
    return { kind: "call", ...ids, ...audited, decision: "block", reason, stages: trail.list() };
  };
  try {
    const kind = classifyTool(event.toolName, deps.toolFacts(event.toolName));
    audited = { category: kind.category, args: UNREADABLE_INPUT };
    const exec = kind.category === "exec" && kind.builtin;
    // Both throw on an input that cannot be stated: the catch below blocks the call.
    const args = auditArgs(event.input, exec, deps.redact);
    audited = { category: kind.category, args };
    const prepared: Prepared = {
      kind,
      exec,
      args,
      key: grantKey(event.toolName, grantPayload(event.input, exec)),
    };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = deps.rulesVersion();
      const evaluation = await evaluateOnce(event, ctx, deps, stages, ids, prepared);
      const moved = deps.rulesVersion() !== started;
      // An unanswered allow under rules that moved meanwhile is evaluated again (M5R12 (1)).
      if (moved && !evaluation.answered && evaluation.result === undefined) continue;
      return settle(evaluation, moved, deps, stages);
    }
    deps.audit(fail("policy changed during evaluation"));
    return { block: true, reason: FAIL_CLOSED_REASON };
  } catch (error) {
    // Never the message: it can quote the input (M5R115).
    process.stderr.write(`pi-host: policy evaluation failed (${errorClass(error)})\n`);
    const tooLarge = error instanceof InputTooLarge;
    try {
      deps.audit(fail(tooLarge ? "input too large" : "evaluation error"));
    } catch {
      // The audit sink is what failed, or failed again: the line above says so, and the block is the only safe answer.
    }
    return { block: true, reason: tooLarge ? TOO_LARGE_REASON : FAIL_CLOSED_REASON };
  }
}

// Only a call that runs is re-checked or restored: a block or a denial is already final.
function settle(
  evaluation: Evaluation,
  moved: boolean,
  deps: PipelineDeps,
  stages: Stages,
): ToolCallEventResult | undefined {
  const { call } = evaluation;
  let entry = evaluation.entry;
  let result = evaluation.result;
  if (call && result === undefined && evaluation.answered && moved) {
    const refusal = recheckAnswered(call, deps, stages);
    if (refusal) {
      entry = {
        ...entry,
        decision: "block",
        reason: clipUnits(`policy changed while the question was open: ${refusal.reason}`, MAX_ENTRY_REASON),
      };
      result = { block: true, reason: refusal.modelReason };
    }
  }
  if (call && result === undefined) {
    const restored = stages.restore(call);
    if (restored > 0)
      entry = {
        ...entry,
        stages: [
          ...entry.stages,
          {
            stage: "06",
            outcome: "acted",
            reason: `${restored} secret marker${restored === 1 ? "" : "s"} restored`,
          },
        ],
      };
  }
  if (call) stages.commit(call, entry.decision, result === undefined ? evaluation.guardReleased : null);
  deps.audit(entry);
  return result;
}

/** MQ6: what blocks an answered call once the rules moved while its question was open. Never asks. */
function recheckAnswered(
  call: CallFacts,
  deps: PipelineDeps,
  stages: Stages,
): { reason: string; modelReason: string } | null {
  const rules = deps.rules();
  if (rules === null) return { reason: NO_RULES, modelReason: FAIL_CLOSED_REASON };
  const now: CallFacts = { ...call, rules, tainted: deps.taint.current() };
  for (const verdict of [checkStage(stages.denylist(now)), checkStage(stages.egress(now))])
    if (verdict.outcome === "block") return { reason: verdict.reason, modelReason: verdict.modelReason };
  if (
    rules.approvalMode === "read-only" &&
    (now.kind.category !== "read" || (now.tainted && now.kind.external))
  )
    return { reason: "read-only", modelReason: READ_ONLY_REASON };
  return null;
}

async function evaluateOnce(
  event: PolicyEvent,
  ctx: PolicyContext,
  deps: PipelineDeps,
  stages: Stages,
  ids: Ids,
  { kind, exec, args, key }: Prepared,
): Promise<Evaluation> {
  const trail = createTrail();
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
      ...(reason === undefined ? {} : { reason: clipUnits(reason, MAX_ENTRY_REASON) }),
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
  const call: CallFacts = { event, kind, rules, cwd: ctx.cwd, tainted: deps.taint.current(), key, exec };
  const blocked = (stage: StageId, next: StageId, reason: string, modelReason: string): Evaluation => {
    trail.add(stage, "block", reason);
    trail.skipFrom(next, `blocked at stage ${stage}`);
    return finish(call, "block", reason, { block: true, reason: modelReason });
  };

  for (const [stage, next, run] of [
    ["01", "02", () => stages.denylist(call)],
    ["02", "03", () => stages.egress(call)],
  ] as const) {
    const verdict = checkStage(run());
    if (verdict.outcome === "block") return blocked(stage, next, verdict.reason, verdict.modelReason);
    trail.add(stage, verdict.outcome, verdict.reason);
  }
  const plan = await stages.approval(call, ctx, deps);
  if (plan.outcome === "block") return blocked("03", "04", plan.reason, plan.modelReason);
  if (plan.outcome !== "allow" && plan.outcome !== "ask")
    throw new TypeError("the approval stage returned an unknown outcome");
  const guard = stages.guard(call);
  if (guard.outcome !== "pass" && guard.outcome !== "trip")
    throw new TypeError("the guard returned an unknown outcome");
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
  if (!ctx.hasUI) {
    if (!trip) return blocked("03", "04", "no UI to ask", `pap-policy blocked this ${kind.category} call.`);
    trail.add("03", verdict03, plan.reason);
    trail.add("04", "block", trip.reason);
    return finish(call, "block", trip.reason, {
      block: true,
      reason: `pap-policy stopped this run: ${trip.reason}`,
    });
  }
  const description = describeCall(event.toolName, event.input, { exec, review });
  if (!description.reviewable) return blocked("03", "04", "too long to review", TOO_LONG_REASON);
  if (grantable) {
    const always =
      rules.alwaysAllow.some((rule) => rule.tool === event.toolName && rule.key === key) ||
      deps.grants.hasProvisionalAlways(key);
    const grantedBy = deps.grants.hasSession(key) ? "session rule" : always ? "always rule" : null;
    if (grantedBy) {
      trail.add("03", "allow", grantedBy);
      trail.add("04", "pass");
      return finish(call, "allow", grantedBy, undefined);
    }
  }
  const askedAt = deps.grants.version();
  const outcome = await deps.ask(
    {
      category: kind.category,
      title: TITLES[kind.category],
      message: description.message,
      tool: ids.tool,
      key,
      answers,
      tainted: call.tainted,
      ...(trip ? { guard: trip.rule } : {}),
    },
    ctx.signal,
  );
  trail.add("03", verdict03, plan.reason);
  if (trip) trail.add("04", "ask", trip.reason);
  else trail.add("04", "pass");
  const answered = { answered: true };
  if (outcome.closed)
    return finish(call, "denied", "dialog closed", { block: true, reason: FAIL_CLOSED_REASON }, answered);
  // An answer that was not offered is a refusal, whatever the channel says.
  const offered = answers.includes(outcome.answer);
  if (!offered || outcome.answer === "deny")
    return finish(
      call,
      "denied",
      offered ? (review?.why ?? trip?.reason) : "answer not offered",
      { block: true, reason: DENIED_REASON },
      answered,
    );
  if (grantable && outcome.answer === "session") deps.grants.rememberSession(key);
  if (grantable && outcome.answer === "always") deps.grants.rememberAlways(key, askedAt);
  return finish(
    call,
    "approved",
    review ? `answer: ${outcome.answer}; ${review.why}` : `answer: ${outcome.answer}`,
    undefined,
    { answered: true, guardReleased: trip && outcome.answer === "once" ? trip.rule : null },
  );
}
