import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type {
  ApprovalAnswer,
  CallAuditEntry,
  GuardRule,
  PolicyAuditEntry,
  PolicyRules,
  ToolCategory,
  VmLayout,
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
import { auditArgs, hostHidden, InputTooLarge, UNREADABLE_INPUT } from "./audit-args.ts";
import type { ShellFacts } from "./command-cover.ts";
import { denylistStage } from "./denylist.ts";
import { egressStage } from "./egress.ts";
import { grantKey, grantPayload } from "./grant-key.ts";
import type { PolicyGrants } from "./grants.ts";
import type { MessageMix } from "./message-mix.ts";
import { readsAgentHome, readsRunsFolder } from "./read-target.ts";
import { withRestored } from "./restore.ts";
import { approvalStage, readOnlyRefusal } from "./stage-approval.ts";
import type { ExternalRoots, Taint } from "./taint.ts";
import type { VmFileRoots } from "./vm-paths.ts";
import type { EditReview } from "./target-path.ts";
import { classifyTool, type ToolFacts, type ToolKind } from "./tool-kind.ts";
import { clipUnits, createTrail, MAX_ID_LENGTH as MAX_FIELD } from "./trail.ts";
import { checkStage, refuses } from "./unchecked.ts";

export const TOO_LARGE_REASON = "pap-policy blocked this call: its input is too large to judge.";
export { DENIED_REASON, FAIL_CLOSED_REASON, TOO_LONG_REASON } from "./evaluate-once.ts";
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
  /** What the stages judge with (W5-R53): the session's taint, except for a call autonomy covers, which is judged as if clean. */
  readonly tainted: boolean;
  /** `tainted` was lowered by autonomy for this call: the allow row says `trusted autonomy`. */
  readonly autonomyLifted?: boolean;
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
      /** What the audit trail says instead of `reason` when the card names a host an agent chose (W5-R54). */
      readonly auditReason?: string;
      /** The card's title when the stage writes its own (platform calls); the message then starts with `reason`. */
      readonly title?: string;
      readonly answers: readonly ApprovalAnswer[];
      /** The host a `host` answer allows (the `network_request` card, owner a2). */
      readonly host?: string;
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
  /** The session's own id once Pi has made it: its attachments are the only ones its reads may take unasked. */
  sessionId?(): string | undefined;
  /** The worker's home, for `~` in shell commands (Task 1c). */
  readonly home: string;
  /** The shell facts read-only commands depend on, read at each evaluation (M7R15). */
  shell(): ShellFacts;
  toolFacts(toolName: string): ToolFacts | undefined;
  /** `causes` names what tainted the session on the card (decision 117, A3); a bed without it shows none. */
  readonly taint: Pick<Taint, "current"> & Partial<Pick<Taint, "causes">>;
  /** The set stage 07 reads (M5R39): a call that reads an agent's runs folder is put in it before it runs (M11R181). */
  readonly externalRoots?: ExternalRoots;
  /** Keeps a sandboxed shell and Pi's path tools out of one assistant message (W5-R11). */
  readonly messageMix?: MessageMix;
  redact(text: string): string;
  /** Redacts a reason, whatever its case, before a verdict or an entry clips it. */
  redactReason(text: string): string;
  readonly stages?: Partial<Stages>;
  /** A worker in an agent's VM: no host agent folder, runs folder or protected root exists there; the VM file rule decides (spec §5). */
  readonly vm?: { readonly layout: VmLayout; readonly roots: VmFileRoots };
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
  const { messageMix } = deps;
  if (messageMix) {
    const inner = stages.egress;
    stages.egress = (call) => {
      const verdict = inner(call);
      return verdict.outcome === "block" ? verdict : (messageMix.refusal(call) ?? verdict);
    };
  }
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
    const rules = deps.rules();
    const kind = classifyTool(event.toolName, deps.toolFacts(event.toolName), rules?.localTools);
    audited = { category: kind.category, args: UNREADABLE_INPUT };
    // Pi's own shell and pap's sandboxed one: the command is judged, keyed and audited as a command (M11R25).
    const exec = kind.category === "exec" && (kind.builtin || kind.sandboxed === true);
    // Both throw on an input that cannot be stated: the catch below blocks the call.
    // W5-R54: the host an agent asks for is written to the audit as a hash and a length; the card keeps the exact host.
    const args = auditArgs(
      kind.platform?.op === "network.request" ? hostHidden(event.input) : event.input,
      exec,
      deps.redact,
    );
    audited = { category: kind.category, args };
    const prepared: Prepared = {
      kind,
      exec,
      args,
      key: grantKey(event.toolName, grantPayload(event.input, exec)),
    };
    // M11R181: what an agent's runs folders hold was written by runs nobody watched: its result is external content.
    const readDirs = {
      cwd: ctx.cwd,
      papHome: deps.papHome,
      profile: rules?.profile,
      agentScratch: rules?.agentScratch,
      agentHome: rules?.agentHome,
    };
    // The label of the fence: a runs folder's output, or another agent's home (W5-R45).
    const agentRead =
      deps.vm === undefined && kind.builtin && kind.category === "read"
        ? (await readsRunsFolder(event.toolName, event.input, readDirs))
          ? "agent-run"
          : (await readsAgentHome(event.toolName, event.input, readDirs))
            ? "agent-home"
            : null
        : null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = deps.rulesVersion();
      const evaluation = await evaluateOnce(event, ctx, deps, stages, ids, prepared);
      const moved = deps.rulesVersion() !== started;
      // An unanswered allow under rules that moved meanwhile is evaluated again (M5R12 (1)).
      if (moved && !evaluation.answered && evaluation.result === undefined) continue;
      const result = settle(evaluation, moved, deps, stages);
      // Only a call that runs counts: a refused or denied read leaves nothing to fence, nothing to mix.
      if (result === undefined && evaluation.call) {
        messageMix?.allowed(evaluation.call);
        if (agentRead !== null) deps.externalRoots?.add(ids.toolCallId, agentRead);
      }
      return result;
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
