import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type {
  ApprovalAnswer,
  CallAuditEntry,
  GuardRule,
  PolicyAuditEntry,
  PolicyRules,
  ToolCategory,
} from "@pap/contracts";
import type { ApprovalAsk, ApprovalOutcome } from "../approvals.ts";
import { errorClass } from "../bounded.ts";
import {
  type Evaluation,
  evaluateOnce,
  FAIL_CLOSED_REASON,
  type Ids,
  type Prepared,
  MAX_ENTRY_REASON,
  NO_RULES,
} from "./evaluate-once.ts";
import { auditArgs, InputTooLarge, UNREADABLE_INPUT } from "./audit-args.ts";
import { denylistStage } from "./denylist.ts";
import { egressStage } from "./egress.ts";
import { grantKey, grantPayload } from "./grant-key.ts";
import type { PolicyGrants } from "./grants.ts";
import { withRestored } from "./restore.ts";
import { approvalStage, readOnlyRefusal } from "./stage-approval.ts";
import type { EditReview } from "./target-path.ts";
import { classifyTool, type ToolFacts, type ToolKind } from "./tool-kind.ts";
import { clipUnits, createTrail } from "./trail.ts";
import { checkStage, refuses } from "./unchecked.ts";

export const TOO_LARGE_REASON = "pap-policy blocked this call: its input is too large to judge.";
export { DENIED_REASON, FAIL_CLOSED_REASON, TOO_LONG_REASON } from "./evaluate-once.ts";
const MAX_FIELD = 256;
/** Evaluations of one call before a moving rules version blocks it (M5R12). */
const MAX_ATTEMPTS = 3;

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
  | { readonly outcome: "block"; readonly reason: string; readonly modelReason: string }
  | { readonly outcome: "unchecked"; readonly reason: string; readonly modelReason: string };
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
  /** Puts back what `restore` wrote, when the call is blocked after all (the audit or the commit failed). */
  unrestore(call: CallFacts): void;
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
  /** Redacts a reason, whatever its case, before a verdict or an entry clips it. */
  redactReason(text: string): string;
  readonly stages?: Partial<Stages>;
}

const PASS_THROUGH: Omit<Stages, "approval"> = {
  denylist: denylistStage,
  egress: egressStage,
  guard: () => ({ outcome: "pass" }),
  commit: () => {},
  restore: () => 0,
  unrestore: () => {},
};

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
    const trail = createTrail(deps.redactReason);
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
        reason: clipUnits(
          deps.redactReason(`policy changed while the question was open: ${refusal.reason}`),
          MAX_ENTRY_REASON,
        ),
      };
      result = { block: true, reason: refusal.modelReason };
    }
  }
  const runs = call !== null && result === undefined;
  // Restoring is the last step that can change the input; the line and the commit may throw, and then it is undone.
  if (runs) entry = withRestored(entry, stages.restore(call));
  try {
    // The line first: a sink that throws blocks the call, and a blocked call the guard never counted stays uncounted.
    deps.audit(entry);
    if (call) stages.commit(call, entry.decision, result === undefined ? evaluation.guardReleased : null);
  } catch (error) {
    if (runs) stages.unrestore(call);
    throw error;
  }
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
  for (const verdict of [checkStage(stages.denylist(now), true), checkStage(stages.egress(now))])
    if (refuses(verdict, call)) return { reason: verdict.reason, modelReason: verdict.modelReason };
  return rules.approvalMode === "read-only" ? readOnlyRefusal(call, now) : null;
}
