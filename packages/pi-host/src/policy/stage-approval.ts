import type { ApprovalMode } from "@pap/contracts";
import { coverCommand } from "./command-cover.ts";
import type { ApprovalPlan, CallFacts, PipelineDeps, PolicyContext } from "./pipeline.ts";
import { decide } from "./decide.ts";
import { checkReadTarget } from "./read-target.ts";
import { READ_ONLY_REASON } from "./reasons.ts";
import { checkEditTarget, type EditReview } from "./target-path.ts";

const inputPath = (input: unknown): unknown =>
  typeof input === "object" && input !== null ? (input as { path?: unknown }).path : undefined;

/** M7R11: where a covered shell command runs like a built-in read. */
export const READ_ONLY_COMMAND_MODES: ReadonlySet<ApprovalMode> = new Set([
  "supervised",
  "auto-accept-edits",
]);
export const READ_ONLY_COMMAND_REASON = "read-only command";

/** Decision 75 Q6: Pi's own bash, a mode that allows reads, the owner's switch, and every simple command covered. */
async function readOnlyCommand(call: CallFacts, ctx: PolicyContext, deps: PipelineDeps): Promise<boolean> {
  if (!call.exec || call.event.toolName !== "bash") return false;
  if (!call.rules.readOnlyCommands || !READ_ONLY_COMMAND_MODES.has(call.rules.approvalMode)) return false;
  const command = (call.event.input as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  const cover = await coverCommand(command, {
    cwd: ctx.cwd,
    home: deps.home,
    papHome: deps.papHome,
    agentDir: deps.agentDir,
    sessionId: deps.sessionId?.(),
    shell: deps.shell(),
    readOnly: true,
    tainted: call.tainted,
  });
  return cover.covered;
}

/** A write outside the folder or to a protected path (R14); a built-in read of pap's own files (M5R29). */
async function reviewOf(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<{ review?: EditReview; protectedRead?: EditReview }> {
  const { category } = call.kind;
  if (category === "edit") {
    const check = await checkEditTarget(
      inputPath(call.event.input),
      ctx.cwd,
      [deps.agentDir, deps.papHome],
      deps.papHome,
    );
    return check.auto ? {} : { review: check.review };
  }
  if (category !== "read" || !call.kind.builtin) return {};
  const protectedRead = await checkReadTarget(call.event.toolName, call.event.input, {
    cwd: ctx.cwd,
    papHome: deps.papHome,
    agentDir: deps.agentDir,
    sessionId: deps.sessionId?.(),
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

const PRESET_ASK_REASON = "read-only preset: not a read";

/**
 * M7 Task 15 (MC36): under the read-only preset a call whose category is not `read` (an `unknown` extension tool, an
 * extension that took a built-in's name, anything else the matrix would let run) is never let through unasked, in every
 * approval mode, `full-access` included, whatever the matrix said short of a block. No grant or always rule skips the question. MCP writes are blocked earlier, at stage 02.
 */
function heldByPreset(call: CallFacts): boolean {
  return call.rules.readOnlyPreset && call.kind.category !== "read";
}

/** Stage 03: the approval matrix (`decide`) over the facts of the call. It never puts input text in a reason. */
export async function approvalStage(
  call: CallFacts,
  ctx: PolicyContext,
  deps: PipelineDeps,
): Promise<ApprovalPlan> {
  const { category } = call.kind;
  if (call.rules.profile === "interactive" && (await readOnlyCommand(call, ctx, deps))) {
    // M7R12: a read, never external: taint asks only for what can carry data out.
    const verdict = decide({
      mode: call.rules.approvalMode,
      category: "read",
      tainted: call.tainted,
      external: false,
    });
    if (verdict.decision === "allow" && !heldByPreset(call))
      return { outcome: "allow", reason: READ_ONLY_COMMAND_REASON };
  }
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
  const shown = review ?? protectedRead;
  // Whatever the matrix said short of a block (allow, or its own grantable question), the preset's question is the only
  // one: Deny / Allow once, and nothing a grant or an always rule remembered can skip it.
  if (verdict.decision !== "block" && heldByPreset(call))
    return {
      outcome: "ask",
      reason: verdict.decision === "ask" ? verdict.why : PRESET_ASK_REASON,
      answers: ["deny", "once"],
      ...(shown ? { review: shown } : {}),
      grantable: false,
    };
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
  return {
    outcome: "ask",
    reason: verdict.why,
    answers: verdict.answers,
    ...(shown ? { review: shown } : {}),
    grantable: verdict.grantable,
  };
}
